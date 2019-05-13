#!/usr/bin/env node
import "source-map-support/register";
import { AmiBuildPipeline } from "../lib/pipeline";

import cdk = require("@aws-cdk/cdk");

const app = new cdk.App();

new AmiBuildPipeline(app, "myApp", {
    subnetId: "subnet-0d20f3cd7f6315965",
    sourceBucketName: "ami-source-4c709489",
    sourceKey: "example-ami.zip",
    testHarnessRepoName: "codebuild-inspec-test-harness",
    shareWith: {
        642728340982: ["us-west-1", "us-east-2"]
    }
});
