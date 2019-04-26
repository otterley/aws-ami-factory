# encoding: utf-8
# Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

title 'Web server'

describe package('httpd') do
  it { should be_installed }
end

describe service('httpd') do
  it { should be_running }
end

describe port(80) do
  its('processes') { should include 'httpd' }
  its('protocols') { should include 'tcp' }
  its('addresses') { should include '0.0.0.0' }
end
