#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { HelpdeskTriageStack } from "../lib/helpdesk-triage-stack";

const app = new cdk.App();
const frontendOrigin = app.node.tryGetContext("frontendOrigin");
const triageSecretArn = app.node.tryGetContext("triageSecretArn");
const groqChatModel = app.node.tryGetContext("groqChatModel");

if (!frontendOrigin || !triageSecretArn || !groqChatModel) {
  throw new Error(
    "Provide -c frontendOrigin=<frontend URL>, -c triageSecretArn=<Secrets Manager ARN>, and -c groqChatModel=<model ID>",
  );
}

new HelpdeskTriageStack(app, "HelpdeskTriageStack", {
  frontendOrigin,
  triageSecretArn,
  groqChatModel,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});