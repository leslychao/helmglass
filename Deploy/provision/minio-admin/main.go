package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"sort"
	"time"

	madmin "github.com/minio/madmin-go/v4"
	minio "github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

var buckets = []string{"hg-artifacts", "hg-browser-profiles", "hg-staging"}

type identity struct {
	RootUser     string `json:"rootUser"`
	RootPassword string `json:"rootPassword"`
	APIAccessKey string `json:"apiAccessKey"`
	APISecretKey string `json:"apiSecretKey"`
	CAPEM        string `json:"caPem"`
}

type request struct {
	Mode           string                  `json:"mode"`
	InstallationID string                  `json:"installationId"`
	Identity       identity                `json:"identity"`
	Policy         json.RawMessage         `json:"policy"`
	Lifecycle      lifecycle.Configuration `json:"lifecycle"`
}

type snapshot struct {
	Buckets       map[string]bool `json:"buckets"`
	AccountExists bool            `json:"accountExists"`
	Verified      bool            `json:"verified"`
}

type storage struct {
	root  *minio.Client
	api   *minio.Client
	admin *madmin.AdminClient
	input request
}

func newStorage(input request) (*storage, error) {
	authority := x509.NewCertPool()
	if !authority.AppendCertsFromPEM([]byte(input.Identity.CAPEM)) {
		return nil, errors.New("S3_CA_INVALID")
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: authority, MinVersion: tls.VersionTLS12},
		ResponseHeaderTimeout: 10 * time.Second, TLSHandshakeTimeout: 10 * time.Second, MaxConnsPerHost: 2}
	rootCredentials := credentials.NewStaticV4(input.Identity.RootUser, input.Identity.RootPassword, "")
	root, err := minio.New("minio:9000", &minio.Options{Creds: rootCredentials, Secure: true,
		Transport: transport, BucketLookup: minio.BucketLookupPath, MaxRetries: 1})
	if err != nil {
		return nil, errors.New("S3_CLIENT_INVALID")
	}
	api, err := minio.New("minio:9000", &minio.Options{Creds: credentials.NewStaticV4(input.Identity.APIAccessKey,
		input.Identity.APISecretKey, ""), Secure: true, Transport: transport,
		BucketLookup: minio.BucketLookupPath, MaxRetries: 1})
	if err != nil {
		return nil, errors.New("S3_CLIENT_INVALID")
	}
	// This single-purpose process disables automatic replay before constructing the client.
	madmin.MaxRetry = 1
	admin, err := madmin.NewWithOptions("minio:9000", &madmin.Options{Creds: rootCredentials, Secure: true, Transport: transport})
	if err != nil {
		return nil, errors.New("S3_ADMIN_CLIENT_INVALID")
	}
	return &storage{root: root, api: api, admin: admin, input: input}, nil
}

func accountMissing(err error) bool {
	var response madmin.ErrorResponse
	return errors.As(err, &response) && (response.Code == "XMinioInvalidAccessKey" || response.Code == "NoSuchServiceAccount")
}

func (s *storage) inspect(ctx context.Context) (snapshot, error) {
	result := snapshot{Buckets: make(map[string]bool)}
	for _, bucket := range buckets {
		exists, err := s.root.BucketExists(ctx, bucket)
		if err != nil {
			return result, errors.New("S3_BUCKET_INSPECTION_FAILED")
		}
		result.Buckets[bucket] = exists
	}
	_, err := s.admin.InfoServiceAccount(ctx, s.input.Identity.APIAccessKey)
	if err != nil && !accountMissing(err) {
		return result, errors.New("S3_IDENTITY_INSPECTION_FAILED")
	}
	result.AccountExists = err == nil
	return result, nil
}

func canonical(value any) any {
	switch item := value.(type) {
	case []any:
		for index := range item {
			item[index] = canonical(item[index])
		}
		sort.Slice(item, func(left, right int) bool {
			a, _ := json.Marshal(item[left])
			b, _ := json.Marshal(item[right])
			return bytes.Compare(a, b) < 0
		})
	case map[string]any:
		for key := range item {
			item[key] = canonical(item[key])
		}
	}
	return value
}

func samePolicy(left, right []byte) bool {
	var a, b any
	if json.Unmarshal(left, &a) != nil || json.Unmarshal(right, &b) != nil {
		return false
	}
	return reflect.DeepEqual(canonical(a), canonical(b))
}

func (s *storage) verifyIdentity(ctx context.Context) error {
	info, err := s.admin.InfoServiceAccount(ctx, s.input.Identity.APIAccessKey)
	if err != nil {
		return errors.New("S3_IDENTITY_MISSING")
	}
	if info.ParentUser != s.input.Identity.RootUser || info.AccountStatus != "on" ||
		info.Description != "helm-glass:"+s.input.InstallationID+":api-storage" || info.ImpliedPolicy ||
		!samePolicy([]byte(info.Policy), s.input.Policy) {
		return errors.New("S3_IDENTITY_CONFLICT")
	}
	return nil
}

func (s *storage) apply(ctx context.Context) error {
	current, err := s.inspect(ctx)
	if err != nil {
		return err
	}
	for _, bucket := range buckets {
		if !current.Buckets[bucket] {
			if s.root.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}) != nil {
				return errors.New("S3_BUCKET_CREATE_UNCONFIRMED")
			}
		}
		versioning, err := s.root.GetBucketVersioning(ctx, bucket)
		if err != nil || versioning.Status != "" {
			return errors.New("S3_VERSION_MIGRATION_REQUIRED")
		}
		if s.root.SetBucketPolicy(ctx, bucket, "") != nil {
			return errors.New("S3_PRIVATE_POLICY_UNCONFIRMED")
		}
	}
	if current.AccountExists {
		if err := s.verifyIdentity(ctx); err != nil {
			return err
		}
	} else {
		_, err := s.admin.AddServiceAccount(ctx, madmin.AddServiceAccountReq{
			AccessKey: s.input.Identity.APIAccessKey, SecretKey: s.input.Identity.APISecretKey,
			Name: "helm-api-storage", Description: "helm-glass:" + s.input.InstallationID + ":api-storage", Policy: s.input.Policy,
		})
		if err != nil {
			return errors.New("S3_IDENTITY_CREATE_UNCONFIRMED")
		}
	}
	if s.root.SetBucketLifecycle(ctx, "hg-staging", &s.input.Lifecycle) != nil {
		return errors.New("S3_LIFECYCLE_UNCONFIRMED")
	}
	return nil
}

func (s *storage) verify(ctx context.Context) error {
	if err := s.verifyIdentity(ctx); err != nil {
		return err
	}
	for _, bucket := range buckets {
		versioning, err := s.root.GetBucketVersioning(ctx, bucket)
		if err != nil || versioning.Status != "" {
			return errors.New("S3_VERSION_MIGRATION_REQUIRED")
		}
		policy, err := s.root.GetBucketPolicy(ctx, bucket)
		if err != nil && minio.ToErrorResponse(err).Code != "NoSuchBucketPolicy" {
			return errors.New("S3_PRIVATE_POLICY_UNCONFIRMED")
		}
		if policy != "" {
			return errors.New("S3_BUCKET_POLICY_DRIFT")
		}
		exists, err := s.api.BucketExists(ctx, bucket)
		if err != nil || !exists {
			return errors.New("S3_SERVICE_AUTHENTICATION_FAILED")
		}
	}
	actual, err := s.root.GetBucketLifecycle(ctx, "hg-staging")
	if err != nil || !sameLifecycle(actual, &s.input.Lifecycle) {
		return errors.New("S3_LIFECYCLE_DRIFT")
	}
	return nil
}

func sameLifecycle(left, right *lifecycle.Configuration) bool {
	// JSON is the SDK's public settings shape; XMLName fields belong to its transport.
	a, err := json.Marshal(left)
	if err != nil {
		return false
	}
	b, err := json.Marshal(right)
	return err == nil && samePolicy(a, b)
}

func execute() (snapshot, error) {
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 131073))
	decoder.DisallowUnknownFields()
	var input request
	if decoder.Decode(&input) != nil {
		return snapshot{}, errors.New("S3_INPUT_INVALID")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return snapshot{}, errors.New("S3_INPUT_INVALID")
	}
	s, err := newStorage(input)
	if err != nil {
		return snapshot{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	switch input.Mode {
	case "inspect":
		return s.inspect(ctx)
	case "apply":
		if err := s.apply(ctx); err != nil {
			return snapshot{}, err
		}
	case "verify":
	default:
		return snapshot{}, errors.New("S3_MODE_INVALID")
	}
	if err := s.verify(ctx); err != nil {
		return snapshot{}, err
	}
	result, err := s.inspect(ctx)
	result.Verified = err == nil
	return result, err
}

func main() {
	result, err := execute()
	if err != nil {
		// Only owned codes leave this boundary; SDK errors can contain provider data or credentials.
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(result) != nil {
		os.Exit(1)
	}
}
