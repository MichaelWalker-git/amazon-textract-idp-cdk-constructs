import * as path from 'path';
import {Aws, Duration} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface DocumentSplitterProps {
  /** Lambda function memory configuration (may need to increase for larger documents) */
  readonly lambdaMemoryMB?:number;
  /** Lambda function timeout (may need to increase for larger documents) */
  readonly lambdaTimeout?:number;
  /** Lambda log level */
  readonly lambdaLogLevel?:string;
  /** Bucketname to output data to */
  readonly s3OutputBucket:string;
  /** The prefix to use to output files to */
  readonly s3OutputPrefix:string;
  /** location of input S3 objects - if left empty will generate rule for s3 access to all [*] */
  readonly s3InputBucket?: string;
  /** prefix for input S3 objects - if left empty will generate rule for s3 access to all in bucket */
  readonly s3InputPrefix?: string;
  /** maxNumberOfPagesPerDoc - defines in which chunks to split up the document.
   * Default is 1
   */
  /** number of retries in Step Function flow
   * @default is 100 */
  readonly textractDocumentSplitterMaxRetries?: number;
  /**retyr backoff rate
   * @default is 1.1 */
  readonly textractDocumentSplitterBackoffRate?: number;
  /* @default is 1 */
  readonly textractDocumentSplitterInterval?: number;
  readonly maxNumberOfPagesPerDoc?: number;
  /** List of PolicyStatements to attach to the Lambda function.  */
  readonly inputPolicyStatements?: iam.PolicyStatement[];
  /** List of PolicyStatements to attach to the Lambda function.  */
  readonly outputPolicyStatements?: iam.PolicyStatement[];
}
/**
 * This construct takes in a manifest definition with just the s3Path:
 *
 * example s3Path:
 * {"s3Path": "s3://bucketname/prefix/image.png"}
 *
 *
 * then it generated single page versions of the multi-page file.
 * For PDF the output are single PDF files, for TIFF the output are single TIFF files.
 *
 * Example (Python)
 * ```python
  ```

 *
 */
export class DocumentSplitter extends sfn.StateMachineFragment {
  public readonly startState: sfn.State;
  public readonly endStates: sfn.INextable[];
  public readonly splitterFunction: lambda.IFunction;

  constructor(parent: Construct, id: string, props: DocumentSplitterProps) {
    super(parent, id);

    var lambdaMemoryMB = props.lambdaMemoryMB === undefined ? 10240 : props.lambdaMemoryMB;
    var lambdaTimeout = props.lambdaTimeout === undefined ? 900 : props.lambdaTimeout;
    var maxNumberOfPagesPerDoc = props.maxNumberOfPagesPerDoc === undefined ? 1 : props.maxNumberOfPagesPerDoc;
    var lambdaLogLevel = props.lambdaLogLevel === undefined ? 'DEBUG' : props.lambdaLogLevel;
    var s3OutputPrefix =
      props.s3OutputPrefix === undefined ? '' : props.s3OutputPrefix;
    var s3InputPrefix =
      props.s3InputPrefix === undefined ? '' : props.s3InputPrefix;

    var textractDocumentSplitterMaxRetries = props.textractDocumentSplitterMaxRetries === undefined ? 100 : props.textractDocumentSplitterMaxRetries;
    var textractDocumentSplitterBackoffRate =
      props.textractDocumentSplitterBackoffRate === undefined ? 1.1 : props.textractDocumentSplitterBackoffRate;
    var textractDocumentSplitterInterval = props.textractDocumentSplitterInterval === undefined ? 1 : props.textractDocumentSplitterInterval;

    this.splitterFunction = new lambda.DockerImageFunction(this, 'DocumentSplitterFunction', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../lambda/document_splitter/')),
      memorySize: lambdaMemoryMB,
      architecture: lambda.Architecture.X86_64,
      timeout: Duration.seconds(lambdaTimeout),
      environment: {
        S3_OUTPUT_BUCKET: props.s3OutputBucket,
        S3_OUTPUT_PREFIX: props.s3OutputPrefix,
        LOG_LEVEL: lambdaLogLevel,
        MAX_NUMBER_OF_PAGES_PER_DOC: maxNumberOfPagesPerDoc.toString(),
      },
    });
    /** ################ INPUT BUCKET POLICIES */
    if (props.inputPolicyStatements === undefined) {
      if (props.s3InputBucket === undefined) {
        this.splitterFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:GetObject', 's3:ListBucket'],
            resources: ['*'],
          }),
        );
      } else {
        this.splitterFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [
              path.join(`arn:${Aws.PARTITION}:s3:::${props.s3InputBucket}`, '/*'),
              path.join(`arn:${Aws.PARTITION}:s3:::${props.s3InputBucket}`, s3InputPrefix, '/*'),
            ],
          }),
        );
        this.splitterFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [
              path.join(`arn:${Aws.PARTITION}:s3:::${props.s3InputBucket}`),
            ],
          }),
        );
      }
    } else {
      for (var policyStatement of props.inputPolicyStatements) {
        this.splitterFunction.addToRolePolicy(policyStatement);
      }
    }
    /** ##################### OUTPUT BUCKET POLICIES */
    if (props.outputPolicyStatements === undefined) {
      if (props.s3OutputBucket === undefined) {
        this.splitterFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts', 's3:ListBucketMultipartUploads', 's3:CreateMultipartUpload'],
            resources: ['*'],
          }),
        );
      } else {
        this.splitterFunction.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts', 's3:ListBucketMultipartUploads', 's3:CreateMultipartUpload'],
            resources: [
              path.join(`arn:${Aws.PARTITION}:s3:::${props.s3OutputBucket}`, s3OutputPrefix),
              path.join(`arn:${Aws.PARTITION}:s3:::${props.s3OutputBucket}`, s3OutputPrefix, '/*'),
            ],
          }),
        );
      }
    } else {
      for (var policyStatement of props.outputPolicyStatements) {
        this.splitterFunction.addToRolePolicy(policyStatement);
      }
    }


    const splitterInvoke = new tasks.LambdaInvoke(this, id, {
      lambdaFunction: this.splitterFunction,
      outputPath: '$.Payload',
    });

    splitterInvoke.addRetry({
      maxAttempts: textractDocumentSplitterMaxRetries,
      backoffRate: textractDocumentSplitterBackoffRate,
      interval: Duration.seconds(textractDocumentSplitterInterval),
      errors: ['Lambda.TooManyRequestsException', 'Lambda.Unknown'],
    });
    this.startState=splitterInvoke;
    this.endStates=[splitterInvoke];
  }
}
