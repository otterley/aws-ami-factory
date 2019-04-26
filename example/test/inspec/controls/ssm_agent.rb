# encoding: utf-8
# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

title 'Amazon SSM Agent'

describe package('amazon-ssm-agent') do
  it { should be_installed }
end

describe service('amazon-ssm-agent') do
  it { should be_running }
end
