-include ../../site-config.mk
include ../../include.mk

ifndef TEST_HARNESS_IMAGE
$(error INSPEC_TEST_IMAGE must be set)
endif
TEST_HARNESS_IMAGE_TAG := $(TEST_HARNESS_IMAGE):$(VERSION)

default:
	docker build -t $(TEST_HARNESS_IMAGE_TAG) .
	docker push $(TEST_HARNESS_IMAGE_TAG)
