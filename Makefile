# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

EXAMPLE_FILES := \
		Makefile \
		buildspec.yml \
		packer.json \
		files \
		test

default:
		# Nothing to do

.PHONY: skel
skel: $(TARGET)
		$(if $(TARGET),,$(error TARGET must be specified))
		cd example; \
			for file in $(EXAMPLE_FILES); do \
				cp -R $$file $(realpath $(TARGET)); \
			done
		git init $(realpath $(TARGET))

$(TARGET):
		install -d -m 755 $(realpath $@)
