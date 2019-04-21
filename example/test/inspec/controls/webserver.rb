# encoding: utf-8
# copyright: 2018, The Authors

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
