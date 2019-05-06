import cdk = require('@aws-cdk/cdk');
import s3 = require('@aws-cdk/aws-s3');
import cloudtrail = require('@aws-cdk/aws-cloudtrail');
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import ecr = require('@aws-cdk/aws-ecr');
import kms = require('@aws-cdk/aws-kms');
import iam = require('@aws-cdk/aws-iam');
import actions = require('@aws-cdk/aws-codepipeline-actions');
import lambda = require('@aws-cdk/aws-lambda');
import sfn = require('@aws-cdk/aws-stepfunctions');
import path = require('path');
import { DestinationRoleName } from '../lib/common';

const DefaultPackerVersion = '1.3.5';

export interface AccountSharingMap {
  [accountID: string]: string[];
}

export interface AmiStackProps extends cdk.StackProps {
  subnetId: string,
  sourceBucketName: string,
  sourceKey: string,
  testHarnessRepoName: string,
  shareWith?: AccountSharingMap,
  logRetentionDays?: number,
  artifactRetentionDays?: number,
  buildTimeoutMinutes?: number,
  packerVersion?: string
}

const ec2InteractionPolicyStatement = new iam.PolicyStatement().
  addAllResources().
  addActions(
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

export class AmiBuildPipeline extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: AmiStackProps) {
    super(scope, id + 'BuildPipeline', props);

    // Remove all leading '/' characters from the source key
    props.sourceKey = props.sourceKey.replace(/^\/+/, '');

    const sourceBucket = s3.Bucket.import(this, 'AmiSourceBucket', {
      bucketName: props.sourceBucketName
    });

    // CloudTrail trail used to track S3 uploads so that we can trigger
    // CodePipeline executions when the source code object is updated in the bucket.
    const uploadTrail = new cloudtrail.CloudTrail(this, 'UploadTrail');
    uploadTrail.addS3EventSelector(
      [sourceBucket.bucketArn + '/' + props.sourceKey],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.WriteOnly
      }
    );

    // ECR repository in which to place AMI test harness image
    const testHarnessImageRepo = ecr.Repository.import(this, 'TestHarnessImageRepo', {
      repositoryName: props.testHarnessRepoName,
    });

    // AMI encryption key
    const amiEncryptionKey = new kms.EncryptionKey(this, 'AmiEncryptionKey', {
      description: `AMI encryption key - ${id}`,
    });
    for (const accountId in props.shareWith) {
      // Allow destination account to decrypt AMI
      amiEncryptionKey.addToResourcePolicy(
        new iam.PolicyStatement()
          .addArnPrincipal(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
          .addAction('kms:Decrypt')
          .addAllResources()
      );
      // Destination account decrypts AMI via KMS grant to EC2, so allow that too
      amiEncryptionKey.addToResourcePolicy(
        new iam.PolicyStatement()
          .addArnPrincipal(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
          .addAction('kms:CreateGrant')
          .addAllResources()
          .addCondition('Bool', { 'kms:GrantIsForAWSResource': true })
      );
    }

    const amiEncryptionKeyAlias = new kms.EncryptionKeyAlias(this, 'AmiEncryptionKeyAlias', {
      alias: `alias/ami/${id}`,
      key: amiEncryptionKey
    });

    // AMI builder CodeBuild Project
    const amiBuildProject = new codebuild.PipelineProject(this, 'AmiBuildProject', {
      projectName: `AmiBuilder-${id}`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromDockerHub(`hashicorp/packer:${props.packerVersion || DefaultPackerVersion}`),
        computeType: codebuild.ComputeType.Small,
        environmentVariables: {
          'SUBNET_ID': { value: props.subnetId },
          'KMS_KEY_ID': {
            value: this.formatArn({
              service: 'kms',
              resource: amiEncryptionKeyAlias.aliasName
            })
          }
        }
      },
      timeout: props.buildTimeoutMinutes,
    });
    amiBuildProject.addToRolePolicy(ec2InteractionPolicyStatement);

    // AMI test harness CodeBuild Project
    const amiTestProject = new codebuild.PipelineProject(this, 'AmiTestProject', {
      projectName: `AmiTester-${id}`,
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
    amiTestProject.addToRolePolicy(ec2InteractionPolicyStatement);

    // Ensure AMI builder can use encryptionß key to encrypt snapshots and AMI
    // test harness can decrypt them when starting test instances
    for (const project of [amiBuildProject, amiTestProject]) {
      if (project.role) {
        amiEncryptionKey.addToResourcePolicy(
          new iam.PolicyStatement()
            .addPrincipal(project.role)
            .addActions(
              'kms:Encrypt',
              'kms:Decrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey'
            )
            .addAllResources()
        );
        amiEncryptionKey.addToResourcePolicy(
          new iam.PolicyStatement()
            .addPrincipal(project.role)
            .addActions(
              'kms:CreateGrant',
              'kms:ListGrants',
              'kms:RevokeGrant'
            )
            .addAllResources()
            .addCondition('Bool', { 'kms:GrantIsForAWSResource': true })
        );
      }
    }

    // Construct the build-and-test Pipeline
    const buildOutput = new codepipeline.Artifact('BuildOutput');
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const testOutput = new codepipeline.Artifact('TestOutput');

    const sourceAction = new actions.S3SourceAction({
      actionName: 'Source',
      bucket: sourceBucket,
      bucketKey: props.sourceKey,
      pollForSourceChanges: false,
      output: sourceOutput
    });

    const buildAction = new actions.CodeBuildAction({
      actionName: 'Build',
      project: amiBuildProject,
      input: sourceOutput,
      output: buildOutput,
    });

    const testAction = new actions.CodeBuildAction({
      actionName: 'Test',
      project: amiTestProject,
      input: buildOutput,
      output: testOutput
    });

    // AMI copier step function and tasks
    const copyAmiAssetCode = new lambda.AssetCode(path.join(__dirname, 'copy-ami'));

    // Success notifier
    const successFunction = new lambda.Function(this, 'PutJobSuccessFunction', {
      description: 'Notify CodePipeline of AMI sharing success',
      functionName: `AmiSharingSuccess-${id}`,
      handler: 'index.notifySuccess',
      memorySize: 128,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });

    // Unfortunately, we cannot restrict the success function to notifying only
    // our pipeline without introducing a circular dependency.
    successFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction('codepipeline:PutJobSuccessResult')
        .addAllResources()
    );

    const successTask = new sfn.Task(this, 'PutJobSuccessTask', {
      resource: successFunction
    });

    // Function to kick off snapshot copy
    const copySnapshotFunction = new lambda.Function(this, 'CopySnapshotFunction', {
      description: `Copy snapshot for AMI ${id} to another account`,
      functionName: `CopyAmiSnapshot-${id}`,
      handler: 'index.copyImage',
      memorySize: 128,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });
    copySnapshotFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction('sts:GetCallerIdentity')
        .addAllResources()
    );
    for (const accountId in props.shareWith) {
      copySnapshotFunction.addToRolePolicy(
        new iam.PolicyStatement()
          .addActions('sts:AssumeRole')
          .addResource(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
      );
    }

    // Function to check snapshot progress
    const checkSnapshotFunction = new lambda.Function(this, 'CheckSnapshotFunction', {
      description: `Check progress of snapshot copy of AMI ${id}`,
      functionName: `CheckSnapshotProgress-${id}`,
      handler: 'index.checkSnapshotProgress',
      memorySize: 128,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });
    checkSnapshotFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction('sts:GetCallerIdentity')
        .addAllResources()
    );
    for (const accountId in props.shareWith) {
      checkSnapshotFunction.addToRolePolicy(
        new iam.PolicyStatement()
          .addActions('sts:AssumeRole')
          .addResource(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
      );
    }


    // Function to register AMI after snapshot copy
    const registerImageFunction = new lambda.Function(this, 'RegisterImageFunction', {
      description: `Register AMI ${id}`,
      functionName: `RegisterImage-${id}`,
      handler: 'index.registerImage',
      memorySize: 128,
      logRetentionDays: props.logRetentionDays,
      runtime: lambda.Runtime.NodeJS810,
      code: copyAmiAssetCode,
    });
    registerImageFunction.addToRolePolicy(
      new iam.PolicyStatement()
        .addAction('sts:GetCallerIdentity')
        .addAllResources()
    );
    for (const accountId in props.shareWith) {
      registerImageFunction.addToRolePolicy(
        new iam.PolicyStatement()
          .addActions('sts:AssumeRole')
          .addResource(`arn:aws:iam::${accountId}:role/${DestinationRoleName}`)
      );
    }


    let branches: sfn.IChainable[] = [];
    for (const accountId in props.shareWith) {
      for (const region of props.shareWith[accountId]) {
        const copySnapshotTask = new sfn.Task(this, `CopySnapshotTask${accountId}${region}`, {
          resource: copySnapshotFunction,
          parameters: {
            'sourceImageId.$': '$.sourceImageId',
            'jobId.$': '$.jobId',
            destinationAccountId: accountId,
            destinationRegion: region,
            destinationRoleName: DestinationRoleName,
            kmsKeyAlias: `alias/ami/${id}`,
            amiName: id
          }
        });

        const checkSnapshotTask = new sfn.Task(this, `CheckSnapshotTask${accountId}${region}`, {
          resource: checkSnapshotFunction,
        });

        const registerImageTask = new sfn.Task(this, `RegisterImageTask${accountId}${region}`, {
          resource: registerImageFunction,
        });

        const waitStep = new sfn.Wait(this, `WaitAndRecheck${accountId}${region}`, {
          duration: sfn.WaitDuration.seconds(30)
        })

        const progressChoice = new sfn.Choice(this, `EvalSnapshotProgress${accountId}${region}`);

        const chain = copySnapshotTask
          .next(checkSnapshotTask)
          .next(progressChoice
            .when(
              sfn.Condition.stringEquals('$.snapshotState', 'completed'),
              registerImageTask
            )
            .otherwise(waitStep.next(checkSnapshotTask))
          );

        branches.push(chain);
      }
    }

    const copyTasksParallel = new sfn.Parallel(this, 'CopyTasks');
    copyTasksParallel.branch(...branches);

    const copyStateMachine = new sfn.StateMachine(this, 'AmiCopyStateMachine', {
      definition: copyTasksParallel
        .next(successTask)
    });

    const kickoffCopyFunction = new lambda.Function(this, 'KickoffAmiCopyFunction', {
      description: `Executes Step Function to copy ${id} AMI to other accounts`,
      functionName: `ExecuteAmiCopyStepFunction-${id}`,
      handler: 'index.kickoff',
      memorySize: 128,
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
        .addAction('states:StartExecution')
        .addResource(copyStateMachine.stateMachineArn)
    );

    // Invoke step-function launcher to start AMI copy
    const copyAction = new actions.LambdaInvokeAction({
      actionName: 'Copy',
      inputs: [testOutput],
      lambda: kickoffCopyFunction,
      userParameters: JSON.stringify(props.shareWith),
    });

    // Build pipeline
    new codepipeline.Pipeline(this, 'AmiBuildPipeline', {
      pipelineName: `AmiBuilder-${id}`,
      restartExecutionOnUpdate: false,
      stages: [
        {
          name: 'Source',
          actions: [sourceAction]
        },
        {
          name: 'Build',
          actions: [buildAction]
        },
        {
          name: 'Test',
          actions: [testAction]
        },
        {
          name: 'Copy',
          actions: [copyAction]
        }
      ]
    });
  };
}
