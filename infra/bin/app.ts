#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { MarketplaceStack } from "../lib/marketplace-stack";

const app = new cdk.App();

new MarketplaceStack(app, "MarketplaceAggregatorPrototype", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description:
    "Marketplace aggregator prototype — API, mock marketplace, CloudFront UI",
});

app.synth();
