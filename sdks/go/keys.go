package dominode

import (
	"context"
	"net/url"
)

// KeysResource provides API key management operations.
type KeysResource struct {
	http *httpClient
}

// newKeysResource creates a new KeysResource.
func newKeysResource(http *httpClient) *KeysResource {
	return &KeysResource{http: http}
}

// Create creates a new API key with the given label.
// The raw key is returned only once in the CreatedAPIKey response.
// If label is empty, "Default" is used.
func (k *KeysResource) Create(ctx context.Context, label string) (*CreatedAPIKey, error) {
	if label == "" {
		label = "Default"
	}
	body := map[string]string{"label": label}
	var result CreatedAPIKey
	if err := k.http.post(ctx, "/api/keys", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// List returns all API keys for the authenticated user.
func (k *KeysResource) List(ctx context.Context) ([]APIKey, error) {
	var result ListKeysResponse
	if err := k.http.get(ctx, "/api/keys", &result); err != nil {
		return nil, err
	}
	return result.Keys, nil
}

// Revoke revokes an API key by its ID.
func (k *KeysResource) Revoke(ctx context.Context, id string) error {
	path := "/api/keys/" + url.PathEscape(id)
	var result interface{}
	return k.http.del(ctx, path, &result)
}
