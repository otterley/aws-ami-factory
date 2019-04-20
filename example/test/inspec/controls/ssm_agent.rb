# encoding: utf-8
# copyright: 2018, The Authors

title 'Amazon SSM Agent'

describe package('amazon-ssm-agent') do
  it { should be_installed }
end

describe service('amazon-ssm-agent') do
  it { should be_running }
end
