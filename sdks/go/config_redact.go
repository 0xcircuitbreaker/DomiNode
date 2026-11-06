package dominusnode

import (
	"encoding/json"
	"fmt"
	"io"
)

func redactToken(v string) string {
	if v == "" {
		return ""
	}
	return redacted
}

// configView is Config without credentials or non-printable fields.
type configView struct {
	BaseURL         string      `json:"baseUrl"`
	ProxyHost       string      `json:"proxyHost"`
	HTTPProxyPort   int         `json:"httpProxyPort"`
	SOCKS5ProxyPort int         `json:"socks5ProxyPort"`
	AccessToken     string      `json:"accessToken"`
	RefreshToken    string      `json:"refreshToken"`
	GatewayTLS      *GatewayTLS `json:"gatewayTls,omitempty"`
}

func (c Config) view() configView {
	return configView{
		BaseURL: c.BaseURL, ProxyHost: c.ProxyHost, HTTPProxyPort: c.HTTPProxyPort, SOCKS5ProxyPort: c.SOCKS5ProxyPort,
		AccessToken: redactToken(c.AccessToken), RefreshToken: redactToken(c.RefreshToken), GatewayTLS: c.GatewayTLS,
	}
}

// String implements fmt.Stringer; AccessToken/RefreshToken are redacted.
func (c Config) String() string { return fmt.Sprintf("%+v", c.view()) }

// GoString implements fmt.GoStringer (%#v); tokens are redacted.
func (c Config) GoString() string { return fmt.Sprintf("dominusnode.Config%+v", c.view()) }

// Format makes every fmt verb print the redacted form (never the tokens).
func (c Config) Format(f fmt.State, verb rune) {
	if verb == 'v' && f.Flag('#') {
		_, _ = io.WriteString(f, c.GoString())
		return
	}
	_, _ = io.WriteString(f, c.String())
}

// MarshalJSON implements json.Marshaler; tokens are redacted, HTTPClient/Lookup omitted.
func (c Config) MarshalJSON() ([]byte, error) { return json.Marshal(c.view()) }
