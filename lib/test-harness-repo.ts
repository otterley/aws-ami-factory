import ecr = require('@aws-cdk/aws-ecr');
import iam = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/cdk');

interface AmiTestHarnessRepoStackProps extends cdk.StackProps {
    repoName: string
}

export class AmiTestHarnessRepoStack extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: AmiTestHarnessRepoStackProps) {
        super(scope, id, props);

        const repo = new ecr.Repository(this, 'TestHarnessRepo', {
            repositoryName: props.repoName,
        });
        // workaround, since the grant() methods don't currently work
        // see https://github.com/awslabs/aws-cdk/issues/2473
        repo.addToResourcePolicy(
            new iam.PolicyStatement()
                .addServicePrincipal('codebuild.amazonaws.com')
                .addActions(
                    'ecr:GetDownloadUrlForLayer',
                    'ecr:BatchGetImage',
                    'ecr:BatchCheckLayerAvailability'
                )
        );
    }
}
