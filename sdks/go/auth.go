package dominusnode

import "context"

// AuthResource provides authentication and account management operations.
type AuthResource struct {
	http *httpClient
	tm   *tokenManager
}

// newAuthResource creates a new AuthResource.
func newAuthResource(http *httpClient, tm *tokenManager) *AuthResource {
	return &AuthResource{http: http, tm: tm}
}

// Register creates a new user account with the given email and password.
// On success, the client is automatically authenticated.
func (a *AuthResource) Register(ctx context.Context, email, password string) (*LoginResult, error) {
	body := map[string]string{"email": email, "password": password}
	var result LoginResult
	if err := a.http.postPublic(ctx, "/api/auth/register", body, &result); err != nil {
		return nil, err
	}
	if result.Token != "" {
		a.tm.setTokens(result.Token, result.RefreshToken)
	}
	return &result, nil
}

// Login authenticates with email and password.
// If MFA is required, the returned LoginResult will have MFARequired set to true.
// Call VerifyMFA to complete the authentication flow.
func (a *AuthResource) Login(ctx context.Context, email, password string) (*LoginResult, error) {
	body := map[string]string{"email": email, "password": password}
	var result LoginResult
	if err := a.http.postPublic(ctx, "/api/auth/login", body, &result); err != nil {
		return nil, err
	}
	if result.Token != "" {
		a.tm.setTokens(result.Token, result.RefreshToken)
	}
	return &result, nil
}

// VerifyMFA completes MFA verification after login.
// Use WithMFAChallengeToken and WithBackupCode options to configure the request.
func (a *AuthResource) VerifyMFA(ctx context.Context, code string, opts ...MFAOption) (*LoginResult, error) {
	options := &mfaOptions{}
	for _, opt := range opts {
		opt(options)
	}

	body := map[string]interface{}{
		"code": code,
	}
	if options.mfaChallengeToken != "" {
		body["mfaChallengeToken"] = options.mfaChallengeToken
	}
	if options.isBackupCode {
		body["isBackupCode"] = true
	}

	var result LoginResult
	if err := a.http.postPublic(ctx, "/api/auth/mfa/verify", body, &result); err != nil {
		return nil, err
	}
	if result.Token != "" {
		a.tm.setTokens(result.Token, result.RefreshToken)
	}
	return &result, nil
}

// VerifyKey authenticates using an API key.
// On success, the resulting JWT tokens are stored for subsequent requests.
func (a *AuthResource) VerifyKey(ctx context.Context, apiKey string) (*VerifyKeyResult, error) {
	body := map[string]string{"apiKey": apiKey}
	var result VerifyKeyResult
	if err := a.http.postPublic(ctx, "/api/auth/verify-key", body, &result); err != nil {
		return nil, err
	}
	if result.Token != "" {
		a.tm.setTokens(result.Token, result.RefreshToken)
	}
	return &result, nil
}

// Refresh exchanges a refresh token for a new token pair.
// This is typically called automatically by the token manager,
// but can be called manually if needed.
func (a *AuthResource) Refresh(ctx context.Context, refreshToken string) (*TokenPair, error) {
	body := map[string]string{"refreshToken": refreshToken}
	var result TokenPair
	if err := a.http.postPublic(ctx, "/api/auth/refresh", body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Logout revokes the current session's refresh token on the server
// and clears local tokens.
func (a *AuthResource) Logout(ctx context.Context) error {
	var result interface{}
	err := a.http.post(ctx, "/api/auth/logout", map[string]string{}, &result)
	// Clear tokens regardless of whether the server call succeeded
	a.tm.clear()
	if err != nil {
		return err
	}
	return nil
}

// Me returns the current authenticated user's information.
func (a *AuthResource) Me(ctx context.Context) (*User, error) {
	var result MeResponse
	if err := a.http.get(ctx, "/api/auth/me", &result); err != nil {
		return nil, err
	}
	return &result.User, nil
}

// ChangePassword changes the current user's password.
func (a *AuthResource) ChangePassword(ctx context.Context, currentPassword, newPassword string) error {
	body := ChangePasswordRequest{
		CurrentPassword: currentPassword,
		NewPassword:     newPassword,
	}
	var result interface{}
	return a.http.post(ctx, "/api/auth/change-password", body, &result)
}

// MFASetup initiates MFA setup for the current user.
// Returns the TOTP secret, otpauth URI, and backup codes.
func (a *AuthResource) MFASetup(ctx context.Context) (*MFASetup, error) {
	var result MFASetup
	if err := a.http.post(ctx, "/api/auth/mfa/setup", map[string]string{}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// MFAEnable enables MFA for the current user after verifying a TOTP code.
func (a *AuthResource) MFAEnable(ctx context.Context, code string) error {
	body := map[string]string{"code": code}
	var result MFAEnableResult
	return a.http.post(ctx, "/api/auth/mfa/enable", body, &result)
}

// MFADisable disables MFA for the current user.
// Requires the user's password and a valid TOTP code for verification.
func (a *AuthResource) MFADisable(ctx context.Context, password, code string) error {
	body := map[string]string{"password": password, "code": code}
	var result MFADisableResult
	return a.http.post(ctx, "/api/auth/mfa/disable", body, &result)
}

// MFAStatus returns the current MFA configuration status.
func (a *AuthResource) MFAStatus(ctx context.Context) (*MFAStatus, error) {
	var result MFAStatus
	if err := a.http.get(ctx, "/api/auth/mfa/status", &result); err != nil {
		return nil, err
	}
	return &result, nil
}
