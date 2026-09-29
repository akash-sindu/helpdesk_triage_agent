#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { HelpdeskTriageStack } from "../lib/helpdesk-triage-stack";

const app = new cdk.App();
const frontendOrigin = app.node.tryGetContext("frontendOrigin");
const triageSecretArn = app.node.tryGetContext("triageSecretArn");
const groqChatModel = app.node.tryGetContext("groqChatModel");
const qdrantCollection = process.env.QDRANT_COLLECTION;

if (!frontendOrigin || !triageSecretArn || !groqChatModel || !qdrantCollection) {
  throw new Error(
    "Provide -c frontendOrigin=<frontend URL>, -c triageSecretArn=<Secrets Manager ARN>, -c groqChatModel=<model ID>, and QDRANT_COLLECTION in .env",
  );
}

new HelpdeskTriageStack(app, "HelpdeskTriageStack", {
  frontendOrigin,
  triageSecretArn,
  groqChatModel,
  qdrantCollection,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});