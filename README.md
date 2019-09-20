# Amazon EC2 AMI Factory

This repository contains a factory for constructing build pipelines for Amazon
EC2 machine images (AMIs).  Each pipeline is provided by [AWS
CodePipeline](https://aws.amazon.com/codepipeline/), and the build and test
stages are performed using [AWS CodeBuild](https://aws.amazon.com/codebuild/).
AMIs are built using [Hashicorp Packer](https://packer.io/) and tested with
[InSpec by Chef](https://www.inspec.io/).

## Differences between other approaches

There are plenty of automated AMI builders already out there.  What makes this
one different?

* **Testing:** AMIs produced via AMI Factory are subject to automated testing.
  Test suites are in fact *required* stages in the pipeline.
* **Uses Packer**: AMIs produced via AMI Factory are built with
  [Packer](https://packer.io), so copying files and running arbitrary scripts is
  easy.  Your AMI’s source code repository is authoritative for the build
  process and files transferred during mastering.
* **Multi-account support:** Tested AMIs can be distributed to multiple
  accounts.
* **Multi-region support:** Tested AMIs can be distributed to multiple
  regions in each account.
* **Encryption:** AMIs are encrypted by a KMS key in all target accounts and
  regions.  This can meet stringent organizational requirements.
* **Performance:** Tested AMIs are distributed to accounts and regions in
  parallel.
* **Preserves tags:** All AMI and backing snapshot tags are preserved.
* **Easy configuration:** AMI Factory instances can be configured via a single,
  easy-to-comprehend YAML file.

## Overview

The pipeline template is very simple and consists of four stages.

* Source stage: a ZIP file containing the AMI configuration is uploaded to an S3
  bucket.  This triggers the pipeline execution.
* Build stage: the AMI is built from the supplied configuration.
* Test stage: a test EC2 instance is launched from the AMI built in the build
  stage, and  tested according to the specification provided in the source ZIP
  file.  The AMI is tagged with a pass/fail status reflecting the results of the
  test.
* Deployment stage: The AMI is deployed to the specified accounts and regions.

## Organization

This repository contains:

1. A CDK application for generating an AMI build pipeline and the IAM roles required
   in any foreign accounts to distribute images there
2. Source code for the Docker image run in CodeBuild to run the AMI test harness
3. An example of an AMI source code repository in the [examples](examples/)
   subdirectory.

## Prerequisites

1. A local installation of [Docker](https://docs.docker.com/install/)
2. A local installation of [Node.js](https://nodejs.org/) (currently 10.x LTS is
   supported) and [npm](https://www.npmjs.com/get-npm)

We recommend using [nodenv](https://github.com/nodenv/nodenv) to install and manage
Node.js versions.  It's available in Homebrew if you're a Mac or Linux user.

## Setup steps

After checking out this code repository into a local directory, run `npm install`.

## Create a Build Pipeline

### Step 1: Create a configuration file

Create a file in this repository called `pipeline-config.yaml`.  The schema is
documented in `pipeline-config-schema.json`, but here's an example:

```yaml
# The name of the AMI to be created
amiName: myApp

# A subnet ID (must be publicly routable via an Internet Gateway) in which
# to build and test the AMI
instanceSubnetId: subnet-0d20f3cd7f6315965

# The S3 bucket and key in which the AMI source lives (see below)
sourceS3Bucket: ami-source-4c709489
sourceS3Key: example-ami.zip

# The AWS account ID and region in which the build the pipeline
builderAccountId: 523443631803
builderRegion: us-west-2

# Account IDs and regions to share the tested AMI with
shareWith:
- accountId: 123456789012
  regions:
    - us-west-1
    - us-east-2
    - ap-northeast-1
    - eu-west-1
- accountId: 234567890123
  regions:
    - eu-central-1

# Any tags (key/value) you wish to place on the AMI pipeline resources
# (CodePipeline, CodeBuild, Lambda functions, KMS keys, etc.)
pipelineResourceTags:
  AmiName: myApp
  Creator: otterley
```

## Step 2: Create the necessary IAM roles in your AWS accounts

Each account ID listed in the `shareWith` configuration will automatically have a
CloudFormation stack associated with it that creates the AMI roles necessary for
sharing the tested AMIs.  You'll need to build these one at a time.

Fortunately it's easy to create.  First, you'll need to obtain valid IAM credentials
for each account (environment variables are easiest).  Then simply run:

```shell
npx cdk deploy AmiCopyRole-${ami_name}-${account_id}
```

You can also perform a dry run by running `npx cdk synth AmiCopyRole-${ami_name}-${account_id}`.

To see all the configured stacks, you can run `npx cdk list`.

## Step 3: Create the AMI builder pipeline

This step is easy.  First, you'll need to obtain valid IAM credentials
for the builder account.  Then simply run:

```shell
npx cdk deploy AmiBuildPipeline-${ami_name}
```

You can also perform a dry run by running `npx cdk synth AmiBuildPipeline-${ami_name}`.

To see all the configured stacks, you can run `npx cdk list`.


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
2. The `artifacts` section must include both `manifest.json` and `test/**/*` so
   that the test stage can run properly.

### The `test` subdirectory and `test/buildspec.yml` file

The `test` subdirectory is the root directory of all your tests.  An [example is
provided here](example/test/).

Your InSpec Profile will live in `test/inspec`.  In there, at a minimum, you'll
need to customize `inspec.yml` and place your controls in the `controls`
subdirectory.  Complete documentation for InSpec profiles can be found
[here](https://www.inspec.io/docs/reference/profiles/).

There must also be a file called `buildspec.yml` in the `test` subdirectory.
This spec file is used by CodeBuild during the Testing stage.   The build
command contained in here must include the `testImage` command.  An example can
be found [here](example/test/buildspec.yml).

### Building and publishing your AMI source to S3

Once you've assembled your AMI source code and test suite, you'll need to zip up
the source directory and upload it to S3.  A `Makefile` is included in the
skeleton directory for your convenience.  In there, you'll need to customize the
`SOURCE_S3_BUCKET` and `SOURCE_S3_KEY` variables to be the same values as those
in the `pipeline-config.yaml` file you used to construct your pipeline.

Then, you can simply run:

```
make upload
```

If you've configured the pipeline correctly, you should be able to see the AMI
begin being built in the CodePipeline console.

## Roadmap

* Add support for CodeCommit repositories
* Add support for GitHub repositories
* Automatically create VPC and subnets for build environment if needed
* Allow construction of pipelines via Service Catalog

Authors
-------

* Michael Fischer <fiscmi@amazon.com> - lead developer
