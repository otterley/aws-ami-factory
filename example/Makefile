# encoding: utf-8
# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Edit these to suit your preferences.
# IMPORTANT: SOURCE_S3_BUCKET and SOURCE_S3_KEY must match the parameters
# configured in your AMI pipeline CloudFormation template.
ZIPFILE := example-ami.zip
SOURCE_S3_BUCKET := # see above
SOURCE_S3_KEY := $(ZIPFILE)

SOURCES := \
	packer.json \
	buildspec.yml \
	files \
	test/inspec/inspec.lock \
	test

$(ZIPFILE): $(SOURCES)
	inspec vendor --overwrite test/inspec
	rm -f $(ZIPFILE) &&	zip -r $(ZIPFILE) $^

test/inspec/inspec.lock: test/inspec/inspec.yml
	inspec vendor --overwrite test/inspec

.PHONY: upload
upload: $(ZIPFILE)
	$(if $(SOURCE_S3_BUCKET),,$(error SOURCE_S3_BUCKET must be specified))
	$(if $(SOURCE_S3_KEY),,$(error SOURCE_S3_KEY must be specified))
	aws s3 cp $(ZIPFILE) s3://$(SOURCE_S3_BUCKET)/$(SOURCE_S3_KEY)

.PHONY: clean
clean:
	rm -rf test/inspec/vendor $(ZIPFILE)
