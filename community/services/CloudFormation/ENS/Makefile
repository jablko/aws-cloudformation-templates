.SHELLFLAGS = -c -e

dist != for file in dist/**; do if [ ! -d $$file ]; then echo $$file; fi; done

.PHONY: all
all: packaged.yaml
	aws cloudformation deploy \
	  --template-file packaged.yaml \
	  --stack-name ENS \
	  --capabilities CAPABILITY_IAM \
	  --no-fail-on-empty-changeset \

packaged.yaml: template.yaml $(dist)
	aws cloudformation package \
	  --template-file template.yaml \
	  --s3-bucket $$(aws \
	    --output text \
	    --query StackResourceDetail.PhysicalResourceId \
	    cloudformation describe-stack-resource \
	    --stack-name ENS \
	    --logical-resource-id Bucket \
	  ) \
	  --output-template-file $@ \

dist/**: yarn.lock webpack.config.js src/index.js
	yarn webpack

yarn.lock: #package.json
	# https://github.com/barrysteyn/node-scrypt/issues/178#issuecomment-480038544
	LDFLAGS=-static-libstdc++ yarn

check:: yarn.lock
	-yarn prettier --check $$(git ls-files --cached --others --exclude-standard)
	-yarn eslint --ignore-path .gitignore .

check:: yarn.lock $(dist)
	yarn test
