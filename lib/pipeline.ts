import actions = require("@aws-cdk/aws-codepipeline-actions");
import cdk = require("@aws-cdk/cdk");

import cloudtrail = require("@aws-cdk/aws-cloudtrail");
import codebuild = require("@aws-cdk/aws-codebuild");
import codepipeline = require("@aws-cdk/aws-codepipeline");
import ecr = require("@aws-cdk/aws-ecr");
import iam = require("@aws-cdk/aws-iam");
import kms = require("@aws-cdk/aws-kms");
import lambda = require("@aws-cdk/aws-lambda");
import s3 = require("@aws-cdk/aws-s3");
import sfn = require("@aws-cdk/aws-stepfunctions");
import path = require("path");
import { DestinationRoleName } from "../lib/common";

const DefaultPackerVersion = "1.4.0";

// Map of spoke-account IDs to regions with which AMI should be shared
export interface AccountSharingMap {
  [accountID: string]: string[];
}

export interface AmiStackProps extends cdk.StackProps {
  // The subnet ID in which the Packer builder and test-harness EC2 instances will run
  subnetId: string,
  // The name of the S3 bucket in which the source code should be placed
  sourceBucketName: string,
  // The S3 key where the updated AMI-source ZIP file will be placed by the user
  sourceKey: string,
  // The Docker repo (ECR/Docker Hub) where the test-harness Docker repo lives
  testHarnessRepoName: string,
  // (Optional) Map of spoke account-IDs/regions with which the AMI should be shared
  shareWith?: AccountSharingMap,
  // (Optional) Number of days to retain logs
  logRetentionDays?: number,
  // (Optional) Number of days to retain CodePipeline artifacts
  artifactRetentionDays?: number,
  // (Optional) Number of minutes to wait for CodeBuild (build/test) actions to complete
  buildTimeoutMinutes?: number,
  // (Optional) Packer version number
  packerVersion?: string
}

// Minimum set of EC2 permissions required for Packer and test harness to work
const ec2InteractionPolicyStatement = new iam.PolicyStatement().
  addAllResources().
  addActions(
    "ec2:AttachVolume",
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:CopyImage",
    "ec2:CreateImage",
    "ec2:CreateKeypair",
    "ec2:CreateSecurityGroup",
    "ec2:CreateSnapshot",
    "ec2:CreateTags",
    "ec2:CreateVolume",
    "ec2:DeleteKeyPair",
    "ec2:DeleteSecurityGroup",
    "ec2:DeleteSnapshot",
    "ec2:DeleteVolume",
    "ec2:DeregisterImage",
    "ec2:DescribeImageAttribute",
    "ec2:DescribeImages",
    "ec2:DescribeInstances",
    "ec2:DescribeInstanceStatus",
    "ec2:DescribeRegions",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeSnapshots",
    "ec2:DescribeSubnets",
    "ec2:DescribeTags",
    "ec2:DescribeVolumes",
    "ec2:DetachVolume",
    "ec2:GetPasswordData",
    "ec2:ModifyImageAttribute",
    "ec2:ModifyInstanceAttribute",
    "ec2:ModifySnapshotAttribute",
    "ec2:RegisterImage",
    "ec2:RunInstances",
    "ec2:StopInstances",
    "ec2:TerminateInstances"
  );

// Subclass of sfn.Task that has built-in retries for Lambda transient errors.
// See https://docs.aws.amazon.com/step-functions/latest/dg/bp-lambda-serviceexception.html
// for the rationale behind this.
class RetryTask extends sfn.Task {
  constructor(scope: cdk.Construct, id: string, props: sfn.TaskProps) {
    super(scope, id, props);
    this.addRetry({
      errors: ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"],
      backoffRate: 2,
      intervalSeconds: 2,
      maxAttempts: 6
    });
  }
}

export class AmiBuildPipeline extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: AmiStackProps) {
    super(scope, id + "BuildPipeline", props);

    // Remove all leading '/' characters from the source key
    props.sourceKey = props.sourceKey.replace(/^\/+/, "");

    // The AMI source bucket should already have been created elsewhere, and
    // must have versioning enabled.
    const sourceBucket = s3.Bucket.import(this, "AmiSourceBucket", {
      bucketName: props.sourceBucketName
    });

    // CloudTrail trail used to track S3 uploads so that we can trigger
    // CodePipeline executions when the source code object is updated in the bucket.
    const uploadTrail = new cloudtrail.CloudTrail(this, "UploadTrail");
    uploadTrail.addS3EventSelector(
      [sourceBucket.bucketArn + "/" + props.sourceKey],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.WriteOnly
      }
    );

    // ECR repository in which the test harness lives.  It is created
    // externally.
    const testHarnessImageRepo = ecr.Repository.import(this, "TestHarnessImageRepo", {
      repositoryName: props.testHarnessRepoName,
    });

    // AMI encryption key
    const amiEncryptionKey = new kms.EncryptionKey(this, "AmiEncryptionKey", {
      description: `AMI encryption key - ${id}`,
    });
    for (const accountId in props.shareWith) {
      if (props.shareWith.hasOwnProperty(accountId)) {
        // Allow each spoke account to use the key
        amiEncryptionKey.addToResourcePolicy(
          new iam.PolicyStatement()
            .addArnPrincipal(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
            .addActions(
              "kms:Decrypt",
              "kms:DescribeKey"
            )
            .addAllResources()
        );
        amiEncryptionKey.addToResourcePolicy(
          new iam.PolicyStatement()
            .addArnPrincipal(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
            .addAction("kms:CreateGrant")
            .addAllResources()
            .addCondition("Bool", { "kms:GrantIsForAWSResource": true })
        );
      }
    }
    // Create an alias for the AMI encryption key
    const amiEncryptionKeyAlias = new kms.EncryptionKeyAlias(this, "AmiEncryptionKeyAlias", {
      alias: `alias/ami/${id}`,
      key: amiEncryptionKey
    });

    // AMI builder CodeBuild Project.  Uses Packer image.
    const amiBuildProject = new codebuild.PipelineProject(this, "AmiBuildProject", {
      projectName: `AmiBuilder-${id}`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerHub(`hashicorp/packer:${props.packerVersion || DefaultPackerVersion}`),
        computeType: codebuild.ComputeType.Small,
        environmentVariables: {
          SUBNET_ID: { value: props.subnetId },
          KMS_KEY_ID: {
            value: this.formatArn({
              service: "kms",
              resource: amiEncryptionKeyAlias.aliasName
            })
          }
        }
      },
      timeout: props.buildTimeoutMinutes,
    });
    amiBuildProject.addToRolePolicy(ec2InteractionPolicyStatement);

    // AMI test harness CodeBuild Project.  Uses test-harness image.
    const amiTestProject = new codebuild.PipelineProject(this, "AmiTestProject", {
      projectName: `AmiTester-${id}`,
      buildSpec: "test/buildspec.yml",
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromEcrRepository(testHarnessImageRepo),
        computeType: codebuild.ComputeType.Small,
        environmentVariables: {
          SUBNET_ID: { value: props.subnetId }
        }
      },
      timeout: props.buildTimeoutMinutes,
    });
    amiTestProject.addToRolePolicy(ec2InteractionPolicyStatement);

    // Ensure AMI builder can use encryption key to encrypt snapshots. Ensure AMI
    // test harness can decrypt them when starting test instances.
    for (const project of [amiBuildProject, amiTestProject]) {
      if (project.role) {
        amiEncryptionKey.addToResourcePolicy(
          new iam.PolicyStatement()
            .addPrincipal(project.role)
            .addActions(
              "kms:Encrypt",
              "kms:Decrypt",
              "kms:ReEncrypt*",
              "kms:GenerateDataKey*",
              "kms:DescribeKey"
            )
            .addAllResources()
        );
        amiEncryptionKey.addToResourcePolicy(
          new iam.PolicyStatement()
            .addPrincipal(project.role)
            .addActions(
              "kms:CreateGrant",
              "kms:ListGrants",
              "kms:RevokeGrant"
            )
            .addAllResources()
            .addCondition("Bool", { "kms:GrantIsForAWSResource": true })
        );
      }
    }

    // Declare output artifacts
    const buildOutput = new codepipeline.Artifact("BuildOutput");
    const sourceOutput = new codepipeline.Artifact("SourceOutput");
    const testOutput = new codepipeline.Artifact("TestOutput");

    // Declare actions
    const sourceAction = new actions.S3SourceAction({
      actionName: "Source",
      bucket: sourceBucket,
      bucketKey: props.sourceKey,
      pollForSourceChanges: false,
      output: sourceOutput
    });

    const buildAction = new actions.CodeBuildAction({
      actionName: "Build",
      project: amiBuildProject,
      input: sourceOutput,
      output: buildOutput,
    });

    const testAction = new actions.CodeBuildAction({
      actionName: "Test",
      project: amiTestProject,
      input: buildOutput,
      output: testOutput
    });

    // AMI-copier Lambda functions are located in the copy-ami subdirectory.
    // CDK will handle zipping and uploading the code.
    const copyAmiAssetCode = new lambda.AssetCode(path.join(__dirname, "copy-ami"));

    // Success notifier
    const successFunction = new lambda.Function(this, "PutJobSuccessFunction", {
      description: "Notify CodePipeline of AMI sharing success",
      functionName: `AmiSharingSuccess-${id}`,
      handler: "index.notifySuccess",
      memorySize: 128,
      timeout: 300,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });

    // Unfortunately, we cannot restrict the success function to notifying only
    // our pipeline without introducing a circular dependency.
    successFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("codepipeline:PutJobSuccessResult")
        .addAllResources()
    );

    const successTask = new RetryTask(this, "PutJobSuccessTask", {
      resource: successFunction
    });

    // Failure notifier
    const failureFunction = new lambda.Function(this, "PutJobFailureFunction", {
      description: "Notify CodePipeline of AMI sharing failure",
      functionName: `AmiSharingFailure-${id}`,
      handler: "index.notifyFailure",
      memorySize: 128,
      timeout: 300,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });

    // Unfortunately, we cannot restrict the success function to notifying only
    // our pipeline without introducing a circular dependency.
    failureFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("codepipeline:PutJobFailureResult")
        .addAllResources()
    );

    // Function to start snapshot copy
    const copySnapshotFunction = new lambda.Function(this, "CopySnapshotFunction", {
      description: `Copy snapshot for AMI ${id} to another account`,
      functionName: `CopyAmiSnapshot-${id}`,
      handler: "index.copySnapshot",
      memorySize: 128,
      timeout: 30,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });
    copySnapshotFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("sts:GetCallerIdentity")
        .addAllResources()
    );
    copySnapshotFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("ec2:DescribeImages")
        .addAllResources()
    );
    for (const accountId in props.shareWith) {
      if (props.shareWith.hasOwnProperty(accountId)) {
        copySnapshotFunction.addToRolePolicy(
          new iam.PolicyStatement()
            .addActions("sts:AssumeRole")
            .addResource(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
        );
      }
    }

    // Function to check snapshot progress
    const checkSnapshotFunction = new lambda.Function(this, "CheckSnapshotFunction", {
      description: `Check progress of snapshot copy of AMI ${id}`,
      functionName: `CheckSnapshotProgress-${id}`,
      handler: "index.checkSnapshotProgress",
      memorySize: 128,
      timeout: 30,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });
    checkSnapshotFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("sts:GetCallerIdentity")
        .addAllResources()
    );
    for (const accountId in props.shareWith) {
      if (props.shareWith.hasOwnProperty(accountId)) {
        checkSnapshotFunction.addToRolePolicy(
          new iam.PolicyStatement()
            .addActions("sts:AssumeRole")
            .addResource(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
        );
      }
    }

    // Function to register AMI after snapshot copy
    const registerImageFunction = new lambda.Function(this, "RegisterImageFunction", {
      description: `Register AMI ${id}`,
      functionName: `RegisterImage-${id}`,
      handler: "index.registerImage",
      memorySize: 128,
      timeout: 30,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });
    registerImageFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("sts:GetCallerIdentity")
        .addAllResources()
    );
    for (const accountId in props.shareWith) {
      if (props.shareWith.hasOwnProperty(accountId)) {
        registerImageFunction.addToRolePolicy(
          new iam.PolicyStatement()
            .addActions("sts:AssumeRole")
            .addResource(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
        );
      }
    }

    const failTask = new RetryTask(this, `PutJobFailureTask`, {
      resource: failureFunction,
    }).next(new sfn.Fail(this, `FailCopy`, {
      cause: "Snapshot copy failed"
    }));

    const copySnapshotTask = new RetryTask(this, `CopySnapshotTask`, {
      resource: copySnapshotFunction,
      parameters: {
        "sourceImageId.$": "$.sourceImageId",
        "jobId.$": "$.jobId",
        destinationRoleName: DestinationRoleName,
        kmsKeyAlias: `alias/ami/${id}`,
        amiName: id,
      }
    }).addCatch(failTask);

    const checkSnapshotTask = new RetryTask(this, `CheckSnapshotTask`, {
      resource: checkSnapshotFunction,
    }).addCatch(failTask);

    const registerImageTask = new RetryTask(this, `RegisterImageTask`, {
      resource: registerImageFunction,
    }).addCatch(failTask).next(successTask);

    const waitStep = new sfn.Wait(this, `WaitAndRecheck`, {
      duration: sfn.WaitDuration.seconds(30)
    });

    const progressChoice = new sfn.Choice(this, `EvalSnapshotProgress`)
      .when(
        sfn.Condition.stringEquals("$.snapshotState", "completed"),
        registerImageTask
      )
      .otherwise(
        waitStep.next(checkSnapshotTask)
      );

    const copyStateMachine = new sfn.StateMachine(this, "AmiCopyStateMachine", {
      definition: copySnapshotTask
        .next(checkSnapshotTask)
        .next(progressChoice)
    });

    const kickoffCopyFunction = new lambda.Function(this, "KickoffAmiCopyFunction", {
      description: `Executes Step Function to copy ${id} AMI to other accounts`,
      functionName: `ExecuteAmiCopyStepFunction-${id}`,
      handler: "index.kickoff",
      memorySize: 128,
      timeout: 30,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
      environment: {
        INPUT_ARTIFACT_NAME: testOutput.artifactName,
        STATE_MACHINE_ARN: copyStateMachine.stateMachineArn,
      },
    });
    kickoffCopyFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction("states:StartExecution")
        .addResource(copyStateMachine.stateMachineArn)
    );
    kickoffCopyFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addActions("ec2:ModifySnapshotAttribute", "ec2:DescribeImages")
        .addAllResources()
    );

    const copyActions: codepipeline.Action[] = [];
    // Invoke step-function launcher to start AMI copy

    for (const accountId in props.shareWith) {
      if (props.shareWith.hasOwnProperty(accountId)) {
        const regions = props.shareWith[accountId];
        regions.forEach(region => {
          const action = new actions.LambdaInvokeAction({
            actionName: `Copy-${accountId}-${region}`,
            inputs: [testOutput],
            lambda: kickoffCopyFunction,
            userParameters: JSON.stringify({
              destinationAccountId: accountId,
              destinationRegion: region
            }),
            runOrder: 1 // these should all run in parallel
          });
          copyActions.push(action);
        });
      }
    }

    // Build pipeline
    new codepipeline.Pipeline(this, "AmiBuildPipeline", {
      pipelineName: `AmiBuilder-${id}`,
      restartExecutionOnUpdate: false,
      stages: [
        {
          name: "Source",
          actions: [sourceAction]
        },
        {
          name: "Build",
          actions: [buildAction]
        },
        {
          name: "Test",
          actions: [testAction]
        },
        {
          name: "Copy",
          actions: copyActions
        }
      ]
    });
  }
}
