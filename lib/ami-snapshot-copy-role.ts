import iam = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/cdk');
import { DestinationRoleName } from './common';

export interface AmiSnapshotCopyRoleStackProps extends cdk.StackProps {
    builderAccountId: string
}

export class AmiSnapshotCopyRoleStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: AmiSnapshotCopyRoleStackProps) {
        super(scope, id, props);

        // Create cross-account role allowing the builder (foreign) account to perform
        // snapshot-copying and AMI-creation activities in this (spoke) account.
        const role = new iam.Role(this, 'Role', {
            assumedBy: new iam.AccountPrincipal(props.builderAccountId),
            roleName: DestinationRoleName
        });
        role.addToPolicy(new iam.PolicyStatement()
            .addAllResources()
            .addActions(
                'ec2:CopySnapshot',
                'ec2:CreateImage',
                'ec2:CreateTags',
                'ec2:DescribeImages',
                'ec2:DescribeSnapshots',
                'ec2:RegisterImage',
                'kms:CreateAlias',
                'kms:CreateKey',
                'kms:DescribeKey'
            )
        );
        role.addToPolicy(new iam.PolicyStatement()
            .addAction('kms:CreateGrant')
            .addAllResources()
            .addCondition('Bool', {'kms:GrantIsForAWSResource': true})
        );
    }
}
