STACK_NAME = <Name of CloudFormation stack>
AMI_NAME = <Name of AMI image>
SOURCE_S3_BUCKET = <Name of S3 bucket used to hold AMI source code>
SOURCE_S3_KEY = <Name of S3 object key containing AMI source code ZIP file>
CLOUDTRAIL_S3_BUCKET = <Name of S3 bucket used by CloudTrail to record source code uploads>
PIPELINE_S3_BUCKET = <Name of S3 bucket used to store pipeline artifacts>
SUBNET_ID = <ID of subnet in which build-and-test instances will be run, e.g., subnet-abcd1234>

# Leave this blank - you'll be filling it in later.
# TEST_HARNESS_IMAGE = otterley/ami-pipeline-inspec-test
