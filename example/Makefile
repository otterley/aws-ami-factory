ZIPFILE := example-ami.zip
SOURCES := \
	packer.json \
	baseline.* \
	buildspec.yml \
	test/inspec/inspec.lock

SOURCE_S3_BUCKET := ami-source-f9b824e4
SOURCE_S3_KEY := test.zip

$(ZIPFILE): $(SOURCES)
	zip $(ZIPFILE) $(SOURCES) $(shell find test -type f)

test/inspec/inspec.lock: test/inspec/inspec.yml
	inspec vendor --overwrite test/inspec

.PHONY: upload
upload: $(ZIPFILE)
	aws s3 cp $(ZIPFILE) s3://$(SOURCE_S3_BUCKET)/$(SOURCE_S3_KEY)

.PHONY: clean
clean:
	rm -rf test/inspec/vendor test/inspec/inspec.lock $(ZIPFILE)
