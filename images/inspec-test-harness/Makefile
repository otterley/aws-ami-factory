# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

-include ../../pipeline-config.mk
include ../../include.mk

ifndef TEST_HARNESS_IMAGE
$(error TEST_HARNESS_IMAGE must be set)
endif
TEST_HARNESS_IMAGE_TAG := $(TEST_HARNESS_IMAGE):$(VERSION)

.PHONY: push
push: build
	docker push $(TEST_HARNESS_IMAGE_TAG)

.PHONY: build
build:
	docker build -t $(TEST_HARNESS_IMAGE_TAG) .
