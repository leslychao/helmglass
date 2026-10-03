package main

import (
	"encoding/json"
	"encoding/xml"
	"testing"

	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

func TestLifecycleVerificationAcceptsSDKXMLRoundTripButRejectsChangedRetention(t *testing.T) {
	var desired lifecycle.Configuration
	if err := json.Unmarshal([]byte(`{"Rules":[{"ID":"helm-approved-orphans","Status":"Enabled","Filter":{"And":{"Prefix":"u/","Tags":[{"Key":"helm-gc","Value":"approved"}]}},"Expiration":{"Days":1}}]}`), &desired); err != nil {
		t.Fatal(err)
	}
	wire, err := xml.Marshal(desired)
	if err != nil {
		t.Fatal(err)
	}
	var returned lifecycle.Configuration
	if err := xml.Unmarshal(wire, &returned); err != nil {
		t.Fatal(err)
	}
	if !sameLifecycle(&desired, &returned) {
		t.Fatal("SDK XML transport metadata must not appear as configuration drift")
	}
	returned.Rules[0].RuleFilter.And.Prefix = ""
	if sameLifecycle(&desired, &returned) {
		t.Fatal("A broader deletion filter must be rejected")
	}
}

func TestPolicyVerificationRejectsExpandedObjectScope(t *testing.T) {
	desired := []byte(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":["arn:aws:s3:::hg-artifacts/u/*"]}]}`)
	reordered := []byte(`{"Statement":[{"Resource":["arn:aws:s3:::hg-artifacts/u/*"],"Action":["s3:PutObject","s3:GetObject"],"Effect":"Allow"}],"Version":"2012-10-17"}`)
	if !samePolicy(desired, reordered) {
		t.Fatal("Policy element ordering does not change authorization")
	}
	expanded := []byte(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":["*"]}]}`)
	if samePolicy(desired, expanded) {
		t.Fatal("Expanded service identity resource scope must be rejected")
	}
}
