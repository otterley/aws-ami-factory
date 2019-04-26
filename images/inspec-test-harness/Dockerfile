# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

FROM chef/inspec:3.7.3

COPY testImage /usr/local/lib/testImage/

RUN apk update \
    && apk add --no-cache git openssh-client nodejs npm \
    && npm install -q --only=prod -g /usr/local/lib/testImage \
    && mkdir ~/.ssh \
    && touch ~/.ssh/known_hosts \
    && chmod 600 ~/.ssh/known_hosts \
    && ssh-keyscan -t rsa,dsa -H github.com >> ~/.ssh/known_hosts \
    && ssh-keyscan -t rsa,dsa -H bitbucket.org >> ~/.ssh/known_hosts
