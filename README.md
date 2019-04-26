# Amazon EC2 AMI Build Pipeline Construction Kit

This repository contains a kit for constructing build pipelines for Amazon EC2
machine images (AMIs).  The pipelines are constructed using [AWS
CodePipeline](https://aws.amazon.com/codepipeline/), and the build and test
stages are performed using [AWS CodeBuild](https://aws.amazon.com/codebuild/).
AMIs are built using [Hashicorp Packer](https://packer.io/) and tested with
[InSpec by Chef](https://www.inspec.io/).

## Overview

The pipeline template is very simple and consists of three stages.  An optional
final post-processing stage can also be configured.

* Source stage: a ZIP file containing the AMI configuration is uploaded to an S3
  bucket.  This triggers the pipeline execution.
* Build stage: the AMI is built from the supplied configuration.
* Test stage: a test EC2 instance is launched from the AMI built in the build
  stage, and  tested according to the specification provided in the source ZIP
  file.  The AMI is tagged with a pass/fail status reflecting the results of the
  test.

## Organization

This repository contains:

1. A CloudFormation template and supporting scripts for creating EC2 AMI build and test pipelines; and
2. An example of an AMI source code repository in the [examples](examples/) subdirectory.

## Preparing the test harness Docker image

Before starting anything, you'll want to build and upload the test-harness Docker
image to a Docker image repository such as Amazon ECR](https://aws.amazon.com/ecr/) or
[Docker Hub](https://hub.docker.com).  You only need to do this once, and whenever
an updated version of this kit is released that you wish to upgrade to.

You'll need Docker installed on your development system.  Install Docker for
[Mac](https://hub.docker.com/editions/community/docker-ce-desktop-mac) or for
[Windows](https://hub.docker.com/editions/community/docker-ce-desktop-windows)
if you haven't already.

You'll also need to [install the AWS
CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-install.html) on
your development system if you haven't already, and configure it with the
appropriate credentials.

Next, you'll need to set up a Docker image repository for the test-harness
Docker image.  The name of the image suffix is up to you, but in these examples,
we'll call it `inspec-test-harness`.

### Amazon ECR

If you're using Amazon ECR, you'll want to create the repository first, then log in:

```
export AWS_REGION=us-west-2 # set as appropriate
eval "$(aws ecr get-login --no-include-email --region $AWS_REGION)"
```

Next, create a file in the root directory of this repository called
`pipeline-config.mk`.  Set the `TEST_HARNESS_IMAGE`  variable in this file to
point to the repository URI (which you can find in the ECR console).  For
example,

```
TEST_HARNESS_IMAGE = 123456789012.dkr.ecr.${AWS_REGION}.amazonaws.com/inspec-test-harness
```

### Docker Hub

Create a file in the root directory of this repository called
`pipeline-config.mk`.  Set the `TEST_HARNESS_IMAGE` variable in this file
to your Docker Hub username and repository name, such as:

```
TEST_HARNESS_IMAGE = mydockerid/inspec-test-harness
```

### Build and upload the test harness image

Now, go to the `images/inspec-test-harness` directory and run `make`.  This will
build the Docker image for the test harness and push it to the image registry.


## Create a Build Pipeline

### Create a config file with your site-specific information

Edit the `pipeline-config.mk` file in the root directory of this repository.  It
should contain the following text:

```
TEST_HARNESS_IMAGE = <Name of the test harness image you created above>
SUBNET_ID = <ID of subnet in which build-and-test instances will be run, e.g., subnet-abcd1234>

# The following values must differ for each AMI repository:
SOURCE_S3_BUCKET = <Name of S3 bucket used to hold AMI source code>
SOURCE_S3_KEY = <Name of S3 object key containing AMI source code ZIP file>
CLOUDTRAIL_S3_BUCKET = <Name of S3 bucket used by CloudTrail to record source code uploads>
PIPELINE_S3_BUCKET = <Name of S3 bucket used to store pipeline artifacts>
```

The values for S3 bucket names and keys are your choice, and the buckets will be
created by CloudFormation on your behalf.  (We highly recommend appending random
data to the end of bucket names so as to make them not guessable -- you can
generate suffixes by running `openssl rand -hex 4`.)

With the exception of `TEST_HARNESS_IMAGE` and `SUBNET_ID`, the values should be
unique for each AMI source repository you work with.  The `SOURCE_S3_BUCKET` and
`SOURCE_S3_KEY` values are particularly important, as this is where CodePipeline
will look to find the AMI source code.  We'll discuss in more detail below.

The subnet ID must refer to a **public** VPC subnet that already exists in your
account.  This subnet must have a working route to the Internet via an Internet
Gateway (not a NAT gateway or instance).  **We recommend the VPC be a
non-production VPC, preferably in a non-production AWS account.**


## Your AMI source repository

Your AMI source code will live in a separate repository from this one.  The
repository, at a minimum, must have one file, `buildspec.yml`, and one
subdirectory called `test` with a separate `buildspec.yml` file in it.  Finally,
there must be a `test/inspec` folder in which your tests (controls) and
configuration will be placed.  In summary:

```
buildspec.yml
test/
test/buildspec.yml
test/inspec/
test/inspec/controls/
test/inspec/inspec.yml
```

You can generate a skeleton AMI source repository by running `make TARGET=<dir>
skel` from the root directory of this repository.

### The `buildspec.yml` file

A `buildspec.yml` file must exist at the root of your repository.  This file
tells AWS CodeBuild how to build your AMI using Packer.  If you used the
skeleton builder, the file will look like [this](example/buildspec.yml).

The most important requirements of `buildspec.yml` are:

1. In the `build` phase, `packer` is used to generate the AMI.
2. The `artifacts` section must include both `manifest.json` and `test/**/*`
   so that the test stage can run properly.

### The `test` subdirectory and `test/buildspec.yml` file

The `test` subdirectory is the root directory of all your tests.  An
[example is provided here](example/test/).

Your InSpec Profile will live in `test/inspec`.  In there, at a minimum, you'll need
to customize `inspec.yml` and place your controls in the `controls`
subdirectory.  Complete documentation for InSpec profiles can be found
[here](https://www.inspec.io/docs/reference/profiles/).

There must also be a file called `buildspec.yml` in the `test` subdirectory.
This spec file is used by CodeBuild during the Testing stage.   The build
command contained in here must include the `testImage` command.  An example can
be found [here](example/test/buildspec.yml).

### Building and publishing your AMI to S3

Once you've assembled your AMI source code and test suite, you'll need to zip up
the source directory and upload it to S3.  A `Makefile` is included in the
skeleton directory that can help.  In there, you'll need to customize the
`SOURCE_S3_BUCKET` and `SOURCE_S3_KEY` variables to be the **same** values as
those in the `pipeline-config.mk` file you used to construct your build-and-test
pipeline.

Then, you can simply run:

```
make upload
```

The 





Authors
-------

* Michael Fischer <fiscmi@amazon.com> - lead developer
