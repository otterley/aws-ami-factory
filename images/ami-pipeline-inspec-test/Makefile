IMAGE := otterley/ami-pipeline-inspec-test
VERSION := latest # CHANGEME
TAG := $(IMAGE):$(VERSION)

default:
	docker build -t $(TAG) .
	docker push $(TAG)
