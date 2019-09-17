import actions = require('@aws-cdk/aws-codepipeline-actions');
import cdk = require('@aws-cdk/core');

import cloudtrail = require('@aws-cdk/aws-cloudtrail');
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
// import ecr = require('@aws-cdk/aws-ecr');
import ecrAssets = require('@aws-cdk/aws-ecr-assets');
import iam = require('@aws-cdk/aws-iam');
import kms = require('@aws-cdk/aws-kms');
import lambda = require('@aws-cdk/aws-lambda');
import s3 = require('@aws-cdk/aws-s3');
import sfn = require('@aws-cdk/aws-stepfunctions');
import tasks = require('@aws-cdk/aws-stepfunctions-tasks');
import path = require('path');
import { appTagValue, AppTagName, DestinationRoleName } from './common';

const DefaultPackerVersion = '1.4.3';

// Map of spoke-account IDs to regions with which AMI should be shared
export interface ShareWith {
  accountId: string,
  regions: string[]
}

export interface AmiBuildPipelineStackProps extends cdk.StackProps {
  // Name of the AMI to be build
  amiName: string,
  // The subnet ID in which the Packer builder and test-harness EC2 instances will run
  instanceSubnetId: string,
  // The name of the S3 bucket in which the source code should be placed
  sourceS3Bucket: string,
  // The S3 key where the updated AMI-source ZIP file will be placed by the user
  sourceS3Key: string,
  // (Optional) Map of spoke account-IDs/regions with which the AMI should be shared
  shareWith?: ShareWith[],
  // (Optional) Number of days to retain logs
  logRetentionDays?: number,
  // (Optional) Number of days to retain CodePipeline artifacts
  artifactRetentionDays?: number,
  // (Optional) Number of minutes to wait for CodeBuild (build/test) actions to complete
  buildTimeoutMinutes?: number,
  // (Optional) Packer version number
  packerVersion?: string
  // (Optional) Resource tags
  resourceTags?: {[index: string]: string};
}

// Minimum set of EC2 permissions required for Packer and test harness to work
const ec2InteractionPolicyStatement = new iam.PolicyStatement();
ec2InteractionPolicyStatement.addAllResources();
ec2InteractionPolicyStatement.addActions(
  'ec2:AttachVolume',
  'ec2:AuthorizeSecurityGroupIngress',
  'ec2:CopyImage',
  'ec2:CreateImage',
  'ec2:CreateKeypair',
  'ec2:CreateSecurityGroup',
  'ec2:CreateSnapshot',
  'ec2:CreateTags',
  'ec2:CreateVolume',
  'ec2:DeleteKeyPair',
  'ec2:DeleteSecurityGroup',
  'ec2:DeleteSnapshot',
  'ec2:DeleteVolume',
  'ec2:DeregisterImage',
  'ec2:DescribeImageAttribute',
  'ec2:DescribeImages',
  'ec2:DescribeInstances',
  'ec2:DescribeInstanceStatus',
  'ec2:DescribeRegions',
  'ec2:DescribeSecurityGroups',
  'ec2:DescribeSnapshots',
  'ec2:DescribeSubnets',
  'ec2:DescribeTags',
  'ec2:DescribeVolumes',
  'ec2:DetachVolume',
  'ec2:GetPasswordData',
  'ec2:ModifyImageAttribute',
  'ec2:ModifyInstanceAttribute',
  'ec2:ModifySnapshotAttribute',
  'ec2:RegisterImage',
  'ec2:RunInstances',
  'ec2:StopInstances',
  'ec2:TerminateInstances'
);

// Subclass of sfn.Task that has built-in retries for Lambda transient errors.
// See https://docs.aws.amazon.com/step-functions/latest/dg/bp-lambda-serviceexception.html
// for the rationale behind this.
class RetriableTask extends sfn.Task {
  constructor(scope: cdk.Construct, id: string, props: sfn.TaskProps) {
    super(scope, id, props);
    this.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException'],
      backoffRate: 2,
      interval: cdk.Duration.seconds(2),
      maxAttempts: 6
    });
  }
}

export class AmiBuildPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: AmiBuildPipelineStackProps) {
    super(scope, id, props);

    cdk.Tag.add(this, AppTagName, appTagValue());

    for (const k in props.resourceTags) {
      if (props.resourceTags[k]) {
        cdk.Tag.add(this, k, props.resourceTags[k]);
      }
    }

    // Remove all leading '/' characters from the source key
    props.sourceS3Key = props.sourceS3Key.replace(/^\/+/, '');

    // The AMI source bucket should already have been created elsewhere, and
    // must have versioning enabled.
    const sourceBucket = s3.Bucket.fromBucketName(this, 'AmiSourceBucket', props.sourceS3Bucket);

    // CloudTrail trail used to track S3 uploads so that we can trigger
    // CodePipeline executions when the source code object is updated in the bucket.
    const uploadTrail = new cloudtrail.Trail(this, 'UploadTrail');

    uploadTrail.addS3EventSelector(
      [sourceBucket.bucketArn + '/' + props.sourceS3Key],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.WRITE_ONLY
      }
    );

    // Build test harness image and upload to ECR
    const testHarnessImage = new ecrAssets.DockerImageAsset(this, 'TestHarnessImage', {
      directory: path.join(__dirname, '..', 'images', 'inspec-test-harness'),
    });
    testHarnessImage.repository.grantPull(new iam.ServicePrincipal('codebuild.amazonaws.com'));

    // AMI encryption key
    const amiEncryptionKey = new kms.Key(this, 'AmiEncryptionKey', {
      description: `AMI encryption key - ${props.amiName}`,
    });
    // Allow each spoke account to use the key
    const keystmt1 = new iam.PolicyStatement();
    keystmt1.addActions('kms:Decrypt', 'kms:DescribeKey');
    keystmt1.addAllResources();
    const keystmt2 = new iam.PolicyStatement();
    keystmt2.addActions('kms:CreateGrant');
    keystmt2.addAllResources();
    keystmt2.addCondition('Bool', { 'kms:GrantIsForAWSResource': true });
    for (const shareWith of props.shareWith || []) {
      keystmt1.addArnPrincipal(`arn:aws:iam::${shareWith.accountId}:role/${DestinationRoleName}`);
      keystmt2.addArnPrincipal(`arn:aws:iam::${shareWith.accountId}:role/${DestinationRoleName}`);
    }
    amiEncryptionKey.addToResourcePolicy(keystmt1);
    amiEncryptionKey.addToResourcePolicy(keystmt2);

    // Create an alias for the AMI encryption key
    const amiEncryptionKeyAlias = new kms.Alias(this, 'AmiEncryptionKeyAlias', {
      aliasName: `alias/ami/${props.amiName}`,
      targetKey: amiEncryptionKey
    });

    // AMI builder CodeBuild Project.  Uses Packer image.
    const amiBuildProject = new codebuild.PipelineProject(this, 'AmiBuildProject', {
      projectName: `AmiBuilder-${props.amiName}`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerRegistry(`hashicorp/packer:${props.packerVersion || DefaultPackerVersion}`),
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          SUBNET_ID: { value: props.instanceSubnetId },
          KMS_KEY_ID: {
            value: this.formatArn({
              service: 'kms',
              resource: amiEncryptionKeyAlias.aliasName
            })
          }
        }
      },
      timeout: props.buildTimeoutMinutes ? cdk.Duration.minutes(props.buildTimeoutMinutes) : undefined,
    });
    amiBuildProject.addToRolePolicy(ec2InteractionPolicyStatement);

    // AMI test harness CodeBuild Project.  Uses test-harness image.
    const amiTestProject = new codebuild.PipelineProject(this, 'AmiTestProject', {
      projectName: `AmiTester-${props.amiName}`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename('test/buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromEcrRepository(testHarnessImage.repository),
        computeType: codebuild.ComputeType.SMALL,
        environmentVariables: {
          SUBNET_ID: { value: props.instanceSubnetId }
        }
      },
      timeout: props.buildTimeoutMinutes ? cdk.Duration.minutes(props.buildTimeoutMinutes) : undefined,
    });
    amiTestProject.addToRolePolicy(ec2InteractionPolicyStatement);

    // Ensure AMI builder can use encryption key to encrypt snapshots. Ensure AMI
    // test harness can decrypt them when starting test instances.
    for (const project of [amiBuildProject, amiTestProject]) {
      if (project.role) {
        const stmt1 = new iam.PolicyStatement();
        stmt1.addPrincipals(project.role);
        stmt1.addActions(
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey'
        );
        stmt1.addAllResources();

        const stmt2 = new iam.PolicyStatement();
        stmt2.addPrincipals(project.role);
        stmt2.addActions(
          'kms:CreateGrant',
          'kms:ListGrants',
          'kms:RevokeGrant'
        );
        stmt2.addAllResources();
        stmt2.addCondition('Bool', { 'kms:GrantIsForAWSResource': true });
        amiEncryptionKey.addToResourcePolicy(stmt1);
        amiEncryptionKey.addToResourcePolicy(stmt2);
      }
    }

    // Declare output artifacts
    const buildOutput = new codepipeline.Artifact('BuildOutput');
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const testOutput = new codepipeline.Artifact('TestOutput');

    // Declare actions
    const sourceAction = new actions.S3SourceAction({
      actionName: 'Source',
      bucket: sourceBucket,
      bucketKey: props.sourceS3Key,
      trigger: actions.S3Trigger.EVENTS,
      output: sourceOutput
    });

    const buildAction = new actions.CodeBuildAction({
      actionName: 'Build',
      project: amiBuildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    const testAction = new actions.CodeBuildAction({
      actionName: 'Test',
      project: amiTestProject,
      input: buildOutput,
      outputs: [testOutput]
    });

    // AMI-copier Lambda functions are located in the copy-ami subdirectory.
    // CDK will handle zipping and uploading the code.
    const copyAmiAssetCode = lambda.Code.fromAsset(path.join(__dirname, 'copy-ami'));

    // Success notifier
    const successFunction = new lambda.Function(this, 'PutJobSuccessFunction', {
      description: 'Notify CodePipeline of AMI sharing success',
      functionName: `AmiSharingSuccess-${props.amiName}`,
      handler: 'index.notifySuccess',
      memorySize: 128,
      timeout: cdk.Duration.seconds(300),
      logRetention: props.logRetentionDays,
      runtime: lambda.Runtime.NODEJS_8_10,
      code: copyAmiAssetCode,
    });

    // Unfortunately, we cannot restrict the success function to notifying only
    // our pipeline without introducing a circular dependency.
    const successFunctionPolicyStmt = new iam.PolicyStatement();
    successFunctionPolicyStmt.addActions('codepipeline:PutJobSuccessResult');
    successFunctionPolicyStmt.addAllResources();
    successFunction.addToRolePolicy(successFunctionPolicyStmt);

    const successTask = new RetriableTask(this, 'Job successful', {
      task: new tasks.InvokeFunction(successFunction)
    });

    // Failure notifier
    const failureFunction = new lambda.Function(this, 'PutJobFailureFunction', {
      description: 'Notify CodePipeline of AMI sharing failure',
      functionName: `AmiSharingFailure-${props.amiName}`,
      handler: 'index.notifyFailure',
      memorySize: 128,
      timeout: cdk.Duration.seconds(300),
      logRetention: props.logRetentionDays,
      runtime: lambda.Runtime.NODEJS_8_10,
      code: copyAmiAssetCode,
    });

    const failureFunctionPolicyStmt = new iam.PolicyStatement();
    failureFunctionPolicyStmt.addActions('codepipeline:PutJobFailureResult');
    // Unfortunately, we cannot restrict the success function to notifying only
    // our pipeline without introducing a circular dependency.
    failureFunctionPolicyStmt.addAllResources();
    failureFunction.addToRolePolicy(failureFunctionPolicyStmt);

    // Function to start snapshot copy
    const copySnapshotFunction = new lambda.Function(this, 'CopySnapshotFunction', {
      description: `Copy snapshot for AMI ${props.amiName} to another account`,
      functionName: `CopyAmiSnapshot-${props.amiName}`,
      handler: 'index.copySnapshot',
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logRetention: props.logRetentionDays,
      runtime: lambda.Runtime.NODEJS_8_10,
      code: copyAmiAssetCode,
    });

    const copySnapshotFunctionPolicyStmt = new iam.PolicyStatement();
    copySnapshotFunctionPolicyStmt.addActions('sts:GetCallerIdentity', 'ec2:DescribeImages');
    copySnapshotFunctionPolicyStmt.addAllResources();
    copySnapshotFunction.addToRolePolicy(copySnapshotFunctionPolicyStmt);

    for (const shareWith of props.shareWith || []) {
      const stmt = new iam.PolicyStatement();
      stmt.addActions('sts:AssumeRole');
      stmt.addResources(`arn:aws:iam::${shareWith.accountId}:role/${DestinationRoleName}`);
      copySnapshotFunction.addToRolePolicy(stmt);
    }

    // Function to check snapshot progress
    const checkSnapshotFunction = new lambda.Function(this, 'CheckSnapshotFunction', {
      description: `Check progress of snapshot copy of AMI ${props.amiName}`,
      functionName: `CheckSnapshotProgress-${props.amiName}`,
      handler: 'index.checkSnapshotProgress',
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logRetention: props.logRetentionDays,
      runtime: lambda.Runtime.NODEJS_8_10,
      code: copyAmiAssetCode,
    });

    const checkSnapshotFunctionPolicyStmt = new iam.PolicyStatement();
    checkSnapshotFunctionPolicyStmt.addActions('sts:GetCallerIdentity');
    checkSnapshotFunctionPolicyStmt.addAllResources();
    checkSnapshotFunction.addToRolePolicy(checkSnapshotFunctionPolicyStmt);

    for (const shareWith of props.shareWith || []) {
      const stmt = new iam.PolicyStatement();
      stmt.addActions('sts:AssumeRole');
      stmt.addResources(`arn:aws:iam::${shareWith.accountId}:role/${DestinationRoleName}`);
      checkSnapshotFunction.addToRolePolicy(stmt);
    }

    // Function to register AMI after snapshot copy
    const registerImageFunction = new lambda.Function(this, 'RegisterImageFunction', {
      description: `Register AMI ${props.amiName}`,
      functionName: `RegisterImage-${props.amiName}`,
      handler: 'index.registerImage',
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logRetention: props.logRetentionDays,
      runtime: lambda.Runtime.NODEJS_8_10,
      code: copyAmiAssetCode,
    });
    const registerImageFunctionPolicyStmt = new iam.PolicyStatement();
    registerImageFunctionPolicyStmt.addActions('sts:GetCallerIdentity');
    registerImageFunctionPolicyStmt.addAllResources();
    registerImageFunction.addToRolePolicy(registerImageFunctionPolicyStmt);

    for (const shareWith of props.shareWith || []) {
      const stmt = new iam.PolicyStatement();
      stmt.addActions('sts:AssumeRole');
      stmt.addResources(`arn:aws:iam::${shareWith.accountId}:role/${DestinationRoleName}`);
      registerImageFunction.addToRolePolicy(stmt);
    }

    // Step function states
    const failTask = new RetriableTask(this, `Job failed`, {
      task: new tasks.InvokeFunction(failureFunction),
    }).next(new sfn.Fail(this, `Copy failed`, {
      cause: 'Snapshot copy failed'
    }));

    const copySnapshotTask = new RetriableTask(this, 'Start snapshot copy', {
      task: new tasks.InvokeFunction(copySnapshotFunction)
    }).addCatch(failTask, { resultPath: '$.errorInfo' });

    const checkSnapshotTask = new RetriableTask(this, 'Check snapshot status', {
      task: new tasks.InvokeFunction(checkSnapshotFunction)
    }).addCatch(failTask, { resultPath: '$.errorInfo' });

    const registerImageTask = new RetriableTask(this, 'Register AMI', {
      task: new tasks.InvokeFunction(registerImageFunction)
    }).addCatch(failTask, { resultPath: '$.errorInfo' }).next(successTask);

    const waitStep = new sfn.Wait(this, 'Wait', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30))
    });

    const progressChoice = new sfn.Choice(this, 'Is snapshot ready?')
      .when(
        sfn.Condition.stringEquals('$.snapshotState', 'completed'),
        registerImageTask
      )
      .when(
        sfn.Condition.stringEquals('$.snapshotState', 'error'),
        failTask
      )
      .otherwise(
        waitStep.next(checkSnapshotTask)
      );

    // AMI-copier state machine
    const copyStateMachine = new sfn.StateMachine(this, 'AMICopier-' + props.amiName, {
      definition: copySnapshotTask
        .next(checkSnapshotTask)
        .next(progressChoice)
    });

    // This function kicks off a state machine execution for a given (accountId,
    // region) tuple.
    const kickoffCopyFunction = new lambda.Function(this, 'KickoffAmiCopyFunction', {
      description: `Executes Step Function to copy ${props.amiName} AMI to other accounts`,
      functionName: `ExecuteAmiCopyStepFunction-${props.amiName}`,
      handler: 'index.kickoff',
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      logRetention: props.logRetentionDays,
      runtime: lambda.Runtime.NODEJS_8_10,
      code: copyAmiAssetCode,
      environment: {
        INPUT_ARTIFACT_NAME: testOutput.artifactName || '',
        STATE_MACHINE_ARN: copyStateMachine.stateMachineArn || '',
      },
    });
    const kickoffCopyFunctionPolicyStmt1 = new iam.PolicyStatement();
    kickoffCopyFunctionPolicyStmt1.addActions('states:StartExecution');
    kickoffCopyFunctionPolicyStmt1.addResources(copyStateMachine.stateMachineArn);

    const kickoffCopyFunctionPolicyStmt2 = new iam.PolicyStatement();
    kickoffCopyFunctionPolicyStmt2.addActions('ec2:ModifySnapshotAttribute', 'ec2:DescribeImages', 'codepipeline:PutJobFailureResult');
    kickoffCopyFunctionPolicyStmt2.addAllResources();

    kickoffCopyFunction.addToRolePolicy(kickoffCopyFunctionPolicyStmt1);
    kickoffCopyFunction.addToRolePolicy(kickoffCopyFunctionPolicyStmt2);

    const copyActions: codepipeline.IAction[] = [];
    // Invoke step-function launcher to start AMI copy
    for (const shareWith of props.shareWith || []) {
      const regions = shareWith.regions;
      regions.forEach(region => {
        const action = new actions.LambdaInvokeAction({
          actionName: `Copy-${shareWith.accountId}-${region}`,
          inputs: [testOutput],
          lambda: kickoffCopyFunction,
          userParameters: {
            destinationAccountId: shareWith.accountId,
            destinationRegion: region,
            destinationRoleName: DestinationRoleName,
            kmsKeyAlias: `alias/ami/${props.amiName}`,
            amiName: props.amiName,
          },
          runOrder: 1 // these should all run in parallel
        });
        copyActions.push(action);
      });
    }

    // Build pipeline
    new codepipeline.Pipeline(this, 'AmiBuildPipeline', {
      pipelineName: `AmiBuilder-${props.amiName}`,
      restartExecutionOnUpdate: false,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction]
        },
        {
          stageName: 'Build',
          actions: [buildAction]
        },
        {
          stageName: 'Test',
          actions: [testAction]
        },
        {
          stageName: 'Copy',
          actions: copyActions
        }
      ]
    });
  }
}
