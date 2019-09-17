import iam = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/core');
import { AppTagName, appTagValue, DestinationRoleName } from './common';

export interface AmiCopyRoleProps extends cdk.StackProps {
    builderAccountId: string
}

export class AmiCopyRoleStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: AmiCopyRoleProps) {
        super(scope, id, props);

        cdk.Tag.add(this, AppTagName, appTagValue());

        // Create cross-account role allowing the builder (foreign) account to perform
        // snapshot-copying and AMI-creation activities in this (spoke) account.
        const role = new iam.Role(this, 'Role', {
            assumedBy: new iam.AccountPrincipal(props.builderAccountId),
            roleName: DestinationRoleName
        });
        const basePolicy = new iam.PolicyStatement();
        basePolicy.addAllResources();
        basePolicy.addActions(
            'ec2:CopySnapshot',
            'ec2:CreateImage',
            'ec2:CreateTags',
            'ec2:DescribeImages',
            'ec2:DescribeSnapshots',
            'ec2:RegisterImage',
            'kms:CreateAlias',
            'kms:CreateKey',
            'kms:DescribeKey',
            'kms:PutKeyPolicy'
        );
        role.addToPolicy(basePolicy);

        const kmsGrantPolicy = new iam.PolicyStatement();
        kmsGrantPolicy.addAllResources();
        kmsGrantPolicy.addActions('kms:CreateGrant');
        kmsGrantPolicy.addCondition('Bool', { 'kms:GrantIsForAWSResource': true });
        role.addToPolicy(kmsGrantPolicy);
    }
}