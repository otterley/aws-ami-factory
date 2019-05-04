import cdk = require('@aws-cdk/cdk');
import s3 = require('@aws-cdk/aws-s3');
import cloudtrail = require('@aws-cdk/aws-cloudtrail');
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import ecr = require('@aws-cdk/aws-ecr');
import kms = require('@aws-cdk/aws-kms');
import iam = require('@aws-cdk/aws-iam');
import actions = require('@aws-cdk/aws-codepipeline-actions');

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
      description: 'AMI encryption key',
    });
    for (const accountId in props.shareWith) {
      amiEncryptionKey.addToResourcePolicy(
        new iam.PolicyStatement()
          .addAwsAccountPrincipal(accountId)
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
          .addAwsAccountPrincipal(accountId)
          .addActions(
            'kms:CreateGrant',
            'kms:ListGrants',
            'kms:RevokeGrant'
          )
          .addAllResources()
          .addCondition('Bool', { 'kms:GrantIsForAWSResource': true })
      );
    }

    const amiEncryptionKeyAlias = new kms.EncryptionKeyAlias(this, 'AmiEncryptionKeyAlias', {
      alias: `alias/ami/${id}`,
      key: amiEncryptionKey
    });

    // AMI CodeBuild Project
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

    // Ensure CodeBuild projects can manage encrypted snapshots
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
    const amiBuildPipeline = new codepipeline.Pipeline(this, 'AmiBuildPipeline', {
      pipelineName: `AmiBuilder-${id}`,
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
