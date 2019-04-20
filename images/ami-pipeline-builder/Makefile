IMAGE := otterley/ami-pipeline-builder
VERSION := latest # CHANGEME
TAG := $(IMAGE):$(VERSION)

default:
	docker build -t $(TAG) .
	docker push $(TAG)
