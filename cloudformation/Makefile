-include ../../site-config.mk
include ../../include.mk

ifndef TEST_HARNESS_IMAGE
$(error INSPEC_TEST_IMAGE must be set)
endif

TEST_HARNESS_IMAGE_TAG := $(TEST_HARNESS_IMAGE):$(VERSION)


.PHONY: deploy
deploy:
	aws cloudformation create-stack \
		--stack-name=$(STACK_NAME) \
		--template-body=file://./pipeline.cf.yaml \
		--capabilities CAPABILITY_NAMED_IAM
		--parameters \
			ParameterKey=SourceS3BucketName,ParameterValue=$(SOURCE_S3_BUCKET) \
			ParameterKey=SourceS3Key,ParameterValue=$(SOURCE_S3_KEY) \
			ParameterKey=CloudTrailS3BucketName,ParameterValue=$(CLOUDTRAIL_S3_BUCKET) \
			ParameterKey=AmiName,ParameterValue=$(AMI_NAME) \
			ParameterKey=PipelineS3BucketName,ParameterValue=$(PIPELINE_S3_BUCKET) \
			ParameterKey=BuildSubnetId,ParameterValue=$(SUBNET_ID)
	aws cloudformation wait stack-create-complete  --stack-name $(STACK_NAME)

.PHONY: update
update:
	aws cloudformation update-stack \
		--stack-name=$(STACK_NAME) \
		--template-body=file://./pipeline.cf.yaml \
		--capabilities CAPABILITY_NAMED_IAM
		--parameters \
			ParameterKey=SourceS3BucketName,ParameterValue=$(SOURCE_S3_BUCKET) \
			ParameterKey=SourceS3Key,ParameterValue=$(SOURCE_S3_KEY) \
			ParameterKey=CloudTrailS3BucketName,ParameterValue=$(CLOUDTRAIL_S3_BUCKET) \
			ParameterKey=AmiName,ParameterValue=$(AMI_NAME) \
			ParameterKey=PipelineS3BucketName,ParameterValue=$(PIPELINE_S3_BUCKET) \
			ParameterKey=BuildSubnetId,ParameterValue=$(SUBNET_ID)
	aws cloudformation wait stack-update-complete --stack-name $(STACK_NAME)

.PHONY: delete
delete:
	aws cloudformation delete-stack \
		--stack-name=$(STACK_NAME) \
	aws cloudformation wait stack-delete-complete  --stack-name $(STACK_NAME)
