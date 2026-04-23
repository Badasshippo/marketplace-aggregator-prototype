import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";
import * as path from "path";

const lambdaEntry = (name: string) =>
  path.join(process.cwd(), "lambda", name);

const frontendDist = path.join(process.cwd(), "..", "frontend", "dist");

export class MarketplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const webhookSecret = new secretsmanager.Secret(this, "WebhookSigningSecret", {
      description: "HMAC secret for mock marketplace webhooks",
      generateSecretString: {
        excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\",
        passwordLength: 48,
      },
    });


    const listingsTable = new dynamodb.Table(this, "Listings", {
      partitionKey: { name: "listingId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    listingsTable.addGlobalSecondaryIndex({
      indexName: "idempotency-key-index",
      partitionKey: { name: "idempotencyKey", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const activityTable = new dynamodb.Table(this, "ListingActivity", {
      partitionKey: { name: "listingId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "activityId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mockDlq = new sqs.Queue(this, "MockPublishDLQ", {
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const mockQueue = new sqs.Queue(this, "MockPublishQueue", {
      fifo: true,
      contentBasedDeduplication: false,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { maxReceiveCount: 6, queue: mockDlq },
    });

    const mockAcceptFn = new lambdaNode.NodejsFunction(this, "MockAcceptFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: lambdaEntry("mock-accept.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        MOCK_QUEUE_URL: mockQueue.queueUrl,
      },
      logRetention: logs.RetentionDays.THREE_DAYS,
    });
    mockQueue.grantSendMessages(mockAcceptFn);

    const mockAcceptUrl = mockAcceptFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        // * (ALL) — CloudFormation rejects OPTIONS in AllowMethods; API Lambda calls mock (no browser CORS to mock).
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ["content-type"],
      },
    });

    const apiFn = new lambdaNode.NodejsFunction(this, "ApiFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: lambdaEntry("api-handler.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        LISTINGS_TABLE: listingsTable.tableName,
        ACTIVITY_TABLE: activityTable.tableName,
        IDEMPOTENCY_INDEX_NAME: "idempotency-key-index",
        MOCK_PUBLISH_URL: mockAcceptUrl.url,
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        MOCK_DLQ_URL: mockDlq.queueUrl,
        MOCK_QUEUE_URL: mockQueue.queueUrl,
      },
      logRetention: logs.RetentionDays.THREE_DAYS,
    });
    listingsTable.grantReadWriteData(apiFn);
    activityTable.grantReadWriteData(apiFn);
    webhookSecret.grantRead(apiFn);
    mockDlq.grantConsumeMessages(apiFn);
    mockQueue.grantSendMessages(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:*::foundation-model/anthropic.*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      })
    );

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "marketplace-aggregator-api",
      corsPreflight: {
        allowHeaders: [
          "content-type",
          "idempotency-key",
          "x-marketplace-signature",
          "x-marketplace-timestamp",
          "authorization",
        ],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ["*"],
      },
    });

    const apiIntegration = new apigwv2int.HttpLambdaIntegration(
      "ApiIntegration",
      apiFn
    );
    httpApi.addRoutes({
      path: "/listings",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: "/webhooks/marketplace",
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: "/listings/analyze",
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: "/admin/replay-dlq",
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: "/listings/{listingId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: apiIntegration,
    });
    httpApi.addRoutes({
      path: "/listings/batch-delete",
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    const mockWorkerFn = new lambdaNode.NodejsFunction(this, "MockWorkerFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: lambdaEntry("mock-worker.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      // No reserved concurrency: new accounts often have low regional limits; reserving
      // capacity can push unreserved below the account minimum. Throttle via SQS maxConcurrency instead.
      environment: {
        WEBHOOK_URL: `${httpApi.apiEndpoint}/webhooks/marketplace`,
        WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
      },
      logRetention: logs.RetentionDays.THREE_DAYS,
    });
    webhookSecret.grantRead(mockWorkerFn);
    mockWorkerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(mockQueue, {
        batchSize: 1,
        maxConcurrency: 5,
      })
    );
    mockQueue.grantConsumeMessages(mockWorkerFn);

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

    const staticSecurityHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "StaticSecurityHeaders",
      {
        comment: "Baseline security headers for the SPA origin",
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            override: true,
            frameOption: cloudfront.HeadersFrameOption.SAMEORIGIN,
          },
          referrerPolicy: {
            override: true,
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          },
        },
      }
    );

    const apiDomain = `${httpApi.httpApiId}.execute-api.${this.region}.${this.urlSuffix}`;
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const rewriteApiPath = new cloudfront.Function(this, "RewriteApiPath", {
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var r = event.request;
  if (r.uri.startsWith("/api/")) {
    r.uri = r.uri.replace(/^\\/api/, "");
  }
  return r;
}`),
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: staticSecurityHeaders,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: rewriteApiPath,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.minutes(0),
        },
      ],
    });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(frontendDist)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new cloudwatch.Alarm(this, "ApiErrorAlarm", {
      alarmName: "marketplace-api-lambda-errors",
      alarmDescription: "API Lambda errors > 5 in 5 min",
      metric: apiFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, "DlqDepthAlarm", {
      alarmName: "marketplace-dlq-depth",
      alarmDescription: "Messages visible in mock publish DLQ (failed jobs)",
      metric: mockDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cloudwatch.Alarm(this, "MockWorkerErrorAlarm", {
      alarmName: "marketplace-mock-worker-errors",
      alarmDescription: "Mock worker Lambda errors > 10 in 5 min (synthetic ~15% expected)",
      metric: mockWorkerFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: "Sum" }),
      threshold: 10,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    new cdk.CfnOutput(this, "CloudFrontURL", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Open this URL for the UI (uses /api/* for backend)",
    });
    new cdk.CfnOutput(this, "HttpApiUrl", {
      value: httpApi.apiEndpoint,
      description: "Direct API Gateway URL (for smoke tests / debugging)",
    });
    new cdk.CfnOutput(this, "MockPublishFunctionUrl", {
      value: mockAcceptUrl.url,
      description: "Mock marketplace ingress (also called by API Lambda)",
    });
    new cdk.CfnOutput(this, "WebhookSecretArn", {
      value: webhookSecret.secretArn,
      description: "Secrets Manager ARN (generated at deploy; not in git)",
    });
  }
}
