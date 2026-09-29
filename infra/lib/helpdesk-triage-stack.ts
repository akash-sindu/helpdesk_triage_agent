import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";

interface HelpdeskTriageStackProps extends cdk.StackProps {
  frontendOrigin: string;
  triageSecretArn: string;
  groqChatModel: string;
  qdrantCollection: string;
}

export class HelpdeskTriageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HelpdeskTriageStackProps) {
    super(scope, id, props);

    const tickets = new Table(this, "Tickets", {
      partitionKey: { name: "ticketId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const triageSecret = Secret.fromSecretCompleteArn(
      this,
      "TriageSecret",
      props.triageSecretArn,
    );
    const handler = new NodejsFunction(this, "TriageHandler", {
      entry: path.join(__dirname, "../../backend/src/handler.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(28),
      memorySize: 1024,
      environment: {
        TICKETS_TABLE: tickets.tableName,
        TRIAGE_SECRET_ARN: props.triageSecretArn,
        QDRANT_COLLECTION: props.qdrantCollection,
        GROQ_CHAT_MODEL: props.groqChatModel,
        TRANSFORMERS_CACHE_DIR: "/tmp/transformers-cache",
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        nodeModules: ["@huggingface/transformers"],
        forceDockerBundling: true,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) => [
            `rm -rf "${outputDir}/node_modules/onnxruntime-node/bin/napi-v6/darwin" "${outputDir}/node_modules/onnxruntime-node/bin/napi-v6/win32" "${outputDir}/node_modules/onnxruntime-node/bin/napi-v6/linux/arm64"`,
            `rm -f "${outputDir}/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so" "${outputDir}/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so"`,
            `find "${outputDir}/node_modules/onnxruntime-web" -type f -name '*.map' -delete`,
            `rm -f "${outputDir}/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" "${outputDir}/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm" "${outputDir}/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.wasm" "${outputDir}/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs" "${outputDir}/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jspi.mjs"`,
          ],
        },
      },
    });
    handler.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:Scan"],
        resources: [tickets.tableArn],
      }),
    );
    triageSecret.grantRead(handler);

    const api = new HttpApi(this, "TriageApi", {
      corsPreflight: {
        allowOrigins: [props.frontendOrigin],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST],
        allowHeaders: ["content-type", "x-api-key"],
      },
    });
    const integration = new HttpLambdaIntegration("TriageIntegration", handler);
    api.addRoutes({
      path: "/tickets",
      methods: [HttpMethod.POST, HttpMethod.GET],
      integration,
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "TicketsTableName", { value: tickets.tableName });
  }
}
