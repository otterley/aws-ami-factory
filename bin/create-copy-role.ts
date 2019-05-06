#!/usr/bin/env node
import 'source-map-support/register';
import { DestinationRoleName } from '../lib/common';
import cdk = require('@aws-cdk/cdk');
import iam = require('@aws-cdk/aws-iam');

const ForeignAccount = '523443631803'; // TODO: make this variable

const app = new cdk.App();

interface amiSnapshotCopyRoleStackProps extends cdk.StackProps {
    foreignAccountId: string
};

class AmiSnapshotCopyRoleStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: amiSnapshotCopyRoleStackProps) {
        super(scope, id, props);

        const role = new iam.Role(this, 'Role', {
            assumedBy: new iam.AccountPrincipal(props.foreignAccountId),
            roleName: DestinationRoleName
        });
        role.addToPolicy(new iam.PolicyStatement()
            .addAllResources()
            .addActions(
                'ec2:CopySnapshot',
                'ec2:DescribeImages',
                'ec2:DescribeSnapshots',
                'ec2:CreateImage',
                'ec2:DescribeImages',
                'ec2:CreateTags',
                'ec2:RegisterImage',
                'kms:DescribeKey',
                'kms:CreateKey',
                'kms:CreateAlias'
            )
        );
        // I'm not quite sure why yet, but for some reason this is needed in
        // addition to the CMK's own polices allowing this role the ability to
        // call CreateGrant.
        role.addToPolicy(new iam.PolicyStatement()
            .addAction('kms:CreateGrant')
            .addAllResources()
            .addCondition('Bool', {'kms:GrantIsForAWSResource': true})
        );
    }
}

new AmiSnapshotCopyRoleStack(app, 'AmiSnapshotCopyRole', {
    foreignAccountId: ForeignAccount
});
