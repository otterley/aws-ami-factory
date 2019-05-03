import cdk = require('@aws-cdk/cdk');
import s3 = require('@aws-cdk/aws-s3');
import cloudtrail = require('@aws-cdk/aws-cloudtrail');
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import ecr = require('@aws-cdk/aws-ecr');
import kms = require('@aws-cdk/aws-kms');
import iam = require('@aws-cdk/aws-iam');
import actions = require('@aws-cdk/aws-codepipeline-actions');
//import events = require('@aws-cdk/aws-events');

const DefaultPackerVersion = '1.3.5';

export interface AccountSharingMap {
  [accountID: string]: string[];
}

export interface AmiStackProps extends cdk.StackProps {
  name: string,
  subnetId: string,
  testHarnessRepoName: string,
  sourceBucketName: string,
  sourceKey: string,
  artifactBucketName: string,
  shareWith?: AccountSharingMap,
  logRetentionDays?: number,
  artifactRetentionDays?: number,
  buildTimeoutMinutes?: number,
  packerVersion?: string
}

export class AmiBuildPipeline extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: AmiStackProps) {
    super(scope, id, props);

    // An S3 bucket into which the source code ZIP file should be placed when the AMI is
    // ready to be built and tested.
    const sourceBucket = new s3.Bucket(this, 'AmiSourceBucket', {
      bucketName: props.sourceBucketName,
      encryption: s3.BucketEncryption.S3Managed,
      blockPublicAccess: s3.BlockPublicAccess.BlockAll,
      versioned: true,
    });

    // An S3 bucket used by CodePipeline to pass artifacts between stages and actions.
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: props.artifactBucketName,
      encryption: s3.BucketEncryption.S3Managed,
      blockPublicAccess: s3.BlockPublicAccess.BlockAll,
      lifecycleRules: [
        {
          enabled: true,
          expirationInDays: props.artifactRetentionDays
        }
      ]
    });

    // CloudTrail trail used to track S3 uploads so that we can trigger
    // CodePipeline executions when the source code object is updated in the bucket.
    const uploadTrail = new cloudtrail.CloudTrail(this, 'UploadTrail');
    uploadTrail.addS3EventSelector(
      [artifactBucket.bucketArn],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.WriteOnly
      }
    )

    // ECR repository in which to place AMI test harness image
    const testHarnessImageRepo = new ecr.Repository(this, 'TestHarnessImageRepo', {
      repositoryName: props.testHarnessRepoName,
    });
    // TODO: Make this an output

    // AMI encryption key
    const amiEncryptionKey = new kms.EncryptionKey(this, 'AmiEncryptionKey', {
      description: 'AMI encryption key',
    });
    for (const accountId in props.shareWith) {
      amiEncryptionKey.addToResourcePolicy(
        new iam.PolicyStatement().addAwsAccountPrincipal(accountId).addActions(
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey'
        ).addAllResources()
      );
      amiEncryptionKey.addToResourcePolicy(
        new iam.PolicyStatement().addAwsAccountPrincipal(accountId).addActions(
          'kms:CreateGrant',
          'kms:ListGrants',
          'kms:RevokeGrant'
        ).addAllResources().addCondition('Bool', { 'kms:GrantIsForAWSResource': true })
      );
    }

    const amiBuildProject = new codebuild.PipelineProject(this, 'AmiBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerHub(`hashicorp/packer:${props.packerVersion || DefaultPackerVersion}`),
        computeType: codebuild.ComputeType.Small,
        environmentVariables: {
          'SUBNET_ID': { value: props.subnetId },
          'KMS_KEY_ID': { value: amiEncryptionKey.keyArn }
        }
      },
      timeout: props.buildTimeoutMinutes,
    });

    const amiTestProject = new codebuild.PipelineProject(this, 'AmiTestProject', {
      buildSpec: 'test/buildspec.yml',
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromEcrRepository(testHarnessImageRepo),
        computeType: codebuild.ComputeType.Small,
        environmentVariables: {
          'SUBNET_ID': { value: props.subnetId }
        }
      },
      timeout: props.buildTimeoutMinutes,
    });


    const amiBuildPipeline = new codepipeline.Pipeline(this, 'AmiBuildPipeline', {
      artifactBucket: artifactBucket,
      pipelineName: props.name,
      restartExecutionOnUpdate: false,
    });

    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new actions.S3SourceAction({
      actionName: 'Source',
      bucket: sourceBucket,
      bucketKey: props.sourceKey,
      pollForSourceChanges: false,
      output: sourceOutput
    });
    amiBuildPipeline.addStage({
      name: 'Source',
      actions: [sourceAction]
    });

    const buildOutput = new codepipeline.Artifact();
    const buildAction = new actions.CodeBuildAction({
      actionName: 'Build',
      project: amiBuildProject,
      input: sourceOutput,
      output: buildOutput,
    });
    amiBuildPipeline.addStage({
      name: 'Build',
      actions: [buildAction]
    });

    const testOutput = new codepipeline.Artifact();
    const testAction = new actions.CodeBuildAction({
      actionName: 'Test',
      project: amiTestProject,
      input: buildOutput,
      output: testOutput
    });
    amiBuildPipeline.addStage({
      name: 'Test',
      actions: [testAction]
    });
  };
}
