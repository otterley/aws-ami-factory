#!/usr/bin/env node
import "source-map-support/register";

import ecr = require("@aws-cdk/aws-ecr");
import iam = require("@aws-cdk/aws-iam");
import cdk = require("@aws-cdk/cdk");

const app = new cdk.App();

interface AmiTestHarnessRepoProps extends cdk.StackProps {
    repoName: string
}

class AmiTestHarnessRepo extends cdk.Stack {
    constructor(scope: cdk.Construct, id: string, props: AmiTestHarnessRepoProps) {
        super(scope, id, props);

        const repo = new ecr.Repository(this, "TestHarnessRepo", {
            repositoryName: props.repoName,
        });
        // workaround, since the grant() methods don't presently work
        // see https://github.com/awslabs/aws-cdk/issues/2473
        repo.addToResourcePolicy(
            new iam.PolicyStatement()
                .addServicePrincipal("codebuild.amazonaws.com")
                .addActions(
                    "ecr:GetDownloadUrlForLayer",
                    "ecr:BatchGetImage",
                    "ecr:BatchCheckLayerAvailability"
                )
        );
    }
}

new AmiTestHarnessRepo(app, "AmiBuildPipelineTestHarness", {
    repoName: "codebuild-inspec-test-harness"
});
