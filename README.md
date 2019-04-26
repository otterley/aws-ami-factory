# Amazon EC2 AMI Build Pipeline Construction Kit

This repository contains a kit for constructing build pipelines for
Amazon EC2 machine images (AMIs).  The pipelines are constructed using
AWS CodePipeline, and the build and test stages are performed using
AWS CodeBuild.  AMIs are built using Hashicorp Packer and tested with
Chef InSpec.

## Overview

The pipeline is very simple and consists of three stages.  An optional final
post-processing stage can also be configured.

* Source stage: a ZIP file containing the AMI configuration is uploaded to an S3
  bucket.  This triggers the pipeline execution.
* Build stage: the AMI is built from the supplied configuration.
* Test stage: a test EC2 instance is launched from the AMI built in the build
  stage, and  tested according to the specification provided in the source ZIP
  file.  The AMI is tagged with a pass/fail status reflecting the results of the
  test.

## Preparatory steps

### Create a config file with your site-specific information

First, you'll need to create a file called `site-config.mk` in the root directory
of this repository.  It should contain the following data:

```
SOURCE_S3_BUCKET = < Name of S3 bucket used to hold AMI source code>
SOURCE_S3_KEY = <Name of S3 object key containing AMI source code ZIP file>
CLOUDTRAIL_S3_BUCKET = <Name of S3 bucket used by CloudTrail to record source code uploads>
PIPELINE_S3_BUCKET = <Name of S3 bucket used to store pipeline artifacts>
SUBNET_ID = <ID of subnet in which build-and-test instances will be run, e.g., subnet-abcd1234>

# Leave this blank - you'll be filling it in later.
TEST_HARNESS_IMAGE =
```

The values for S3 bucket names and keys are your choice, and they buckets will be created
by CloudFormation on your behalf.  (We highly recommend appending random data to
the end of bucket names so as to make them not guessable -- you can generate
suffixes by running `openssl rand -hex 4`.)

The subnet ID must refer to a **public** VPC subnet that already exists in your account.

### Prepare the test harness Docker image

First, you'll need Docker installed on your development system.  Install Docker
if you haven't already.

Next, you'll need to set up a Docker image repository for the test-harness
Docker image.  You can use either Amazon ECR or Docker Hub for this.  The name
of the image suffix is up to you, but in these examples, we'll call it
`inspec-test-harness`.

If you're using Amazon ECR, you'll want to create the repository first, then log in:

```
export AWS_REGION=us-west-2 # set as appropriate
eval "$(aws ecr get-login --no-include-email --region $AWS_REGION)"
```

Next, edit the `site-config.mk` file you created above, setting the the
`TEST_HARNESS_IMAGE`  variable to point to the repository URI (which you can find
in the ECR console).  For example,

```
TEST_HARNESS_IMAGE = 123456789012.dkr.ecr.${AWS_REGION}.amazonaws.com/inspec-test-harness
```

If you're using Docker Hub, set `TEST_HARNESS_IMAGE` in your `site-config.mk`
file to your Docker Hub username and repository name, such as:

```
TEST_HARNESS_IMAGE = example/inspec-test-harness
```

Now, go to the `images/inspec-test-harness` directory and run `make`.  This will build
the Docker image for the test harness and push it to the image registry.

## Creating Build and Test Pipelines

Each AMI you build from your source will be associated with its own pipeline.  To build a pipeline, you'll need first to have set up your `site-config.mk` file (see above).  Then,
`cd` to the `cloudformation` directory and run `make`.  This will construct your AMI pipeline using AWS CloudFormation.



Authors
-------

* Michael Fischer <fiscmi@amazon.com> - lead developer
