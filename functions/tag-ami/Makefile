S3_BUCKET := ami-tagger-f9b824e4
S3_KEY := tag-ami.zip

$(S3_KEY): index.js package-lock.json package.json node_modules
	zip -ur $(S3_KEY) $^ package.json

package-lock.json: package.json
	npo install

dep: node_modules
node_modules: package-lock.json
	npm install

.PHONY: upload
upload: $(S3_KEY)
	aws s3 cp $(S3_KEY) s3://$(S3_BUCKET)/$(S3_KEY)

.PHONY: clean
clean:
	rm -rf node_modules *.zip
