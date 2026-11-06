package dominusnode

import (
	"context"
	"math/big"
	"strings"
	"testing"
)

func TestValidationSendsNoRequest(t *testing.T) {
	c, rt := newTestClient(t)
	ctx := context.Background()
	sig129 := "0x" + strings.Repeat("a", 129)
	cases := map[string]func() error{
		"fund 0":       func() error { return e(c.AgenticWallets.Fund(ctx, testUUID, 0)) },
		"fund 2^31":    func() error { return e(c.AgenticWallets.Fund(ctx, testUUID, 2147483648)) },
		"team fund -1": func() error { return e(c.Teams.FundWallet(ctx, testUUID, -1)) },
		"aw spend 2^31": func() error {
			return e(c.AgenticWallets.Create(ctx, "x", CreateAgenticWalletOptions{SpendingLimitCents: Int64(2147483648)}))
		},
		"aw daily -1": func() error {
			return e(c.AgenticWallets.Create(ctx, "x", CreateAgenticWalletOptions{DailyLimitCents: Int64(-1)}))
		},
		"aw policy 2^31": func() error {
			return e(c.AgenticWallets.UpdateWalletPolicy(ctx, testUUID, WalletPolicy{DailyLimitCents: Int64(2147483648)}))
		},
		"topup 999":          func() error { return e(c.Wallet.TopUpCrypto(ctx, 999, "btc")) },
		"topup 100001":       func() error { return e(c.Wallet.TopUpCrypto(ctx, 100001, "btc")) },
		"topup currency":     func() error { return e(c.Wallet.TopUpCrypto(ctx, 1000, "doge")) },
		"crypto status uuid": func() error { return e(c.Wallet.GetCryptoStatus(ctx, "nope")) },
		"convert low":        func() error { return e(c.Credits.Convert(ctx, int64(9_999), "")) },
		"convert high":       func() error { return e(c.Credits.Convert(ctx, "10000000001", "")) },
		"convert float":      func() error { return e(c.Credits.Convert(ctx, 10000.0, "")) },
		"convert lead zero":  func() error { return e(c.Credits.Convert(ctx, "010000", "")) },
		"convert neg big":    func() error { return e(c.Credits.Convert(ctx, big.NewInt(-1), "")) },
		"convert idem short": func() error { return e(c.Credits.Convert(ctx, 10_000, "short")) },
		"convert idem chars": func() error { return e(c.Credits.Convert(ctx, 10_000, "has space!!")) },
		"withdraw low": func() error {
			return e(c.Credits.Withdraw(ctx, WithdrawOptions{AmountMusd: 999_999, Signer: &fakeSigner{addr: testAddr}}))
		},
		"withdraw high": func() error {
			return e(c.Credits.Withdraw(ctx, WithdrawOptions{AmountMusd: "100000000001", Signer: &fakeSigner{addr: testAddr}}))
		},
		"withdraw no signer": func() error { return e(c.Credits.Withdraw(ctx, WithdrawOptions{AmountMusd: 1_000_000})) },
		"withdraw bad signer": func() error {
			return e(c.Credits.Withdraw(ctx, WithdrawOptions{AmountMusd: 1_000_000, Signer: &fakeSigner{addr: "0x12"}}))
		},
		"tx limit":          func() error { return e(c.Credits.Transactions(ctx, CreditTransactionsQuery{Limit: Int(201)})) },
		"tx cursor":         func() error { return e(c.Credits.Transactions(ctx, CreditTransactionsQuery{Cursor: "abc"})) },
		"tx type":           func() error { return e(c.Credits.Transactions(ctx, CreditTransactionsQuery{Type: "steal"})) },
		"challenge addr":    func() error { return e(c.WalletAuth.Challenge(ctx, "0xnothex")) },
		"verify sig 129":    func() error { return e(c.WalletAuth.Verify(ctx, testAddr, sig129)) },
		"verify sig >200":   func() error { return e(c.WalletAuth.Verify(ctx, testAddr, "0x"+strings.Repeat("a", 210))) },
		"verify sig nonhex": func() error { return e(c.WalletAuth.Verify(ctx, testAddr, "0x"+strings.Repeat("g", 130))) },
		"link sig":          func() error { return e(c.WalletAuth.Link(ctx, testAddr, sig129)) },
		"verifyKey format":  func() error { return e(c.Auth.VerifyKey(ctx, "sk_live_x")) },
		"refresh empty":     func() error { return e(c.Auth.Refresh(ctx, "")) },
		"keys label long":   func() error { return e(c.Keys.Create(ctx, strings.Repeat("l", 101))) },
		"keys revoke empty": func() error { return c.Keys.Revoke(ctx, "") },
		"team key label":    func() error { return e(c.Teams.CreateKey(ctx, testUUID, "")) },
		"report uuid":       func() error { return e(c.Sessions.Report(ctx, "x", "slow")) },
		"report reason":     func() error { return e(c.Sessions.Report(ctx, testUUID, "angry")) },
		"node pubkey":       func() error { return e(c.Nodes.RegisterChallenge(ctx, "abc")) },
		"node list limit":   func() error { return e(c.Nodes.List(ctx, Int(0), nil)) },
		"node list offset":  func() error { return e(c.Nodes.List(ctx, nil, Int(1_000_001))) },
		"node revoke uuid":  func() error { return e(c.Nodes.Revoke(ctx, "../x")) },
		"caps none":         func() error { return e(c.Nodes.UpdateCaps(ctx, testUUID, NodeCaps{})) },
		"caps range":        func() error { return e(c.Nodes.UpdateCaps(ctx, testUUID, NodeCaps{ReqPerSec: Int(1_000_001)})) },
		"caps uuid":         func() error { return e(c.Nodes.UpdateCaps(ctx, "x", NodeCaps{ReqPerSec: Int(1)})) },
		"register streams": func() error {
			return e(c.Nodes.Register(ctx, RegisterNodeOptions{Signer: &fakeSigner{addr: testAddr}, MaxStreams: Int(1025)}))
		},
		"register gb": func() error {
			return e(c.Nodes.Register(ctx, RegisterNodeOptions{Signer: &fakeSigner{addr: testAddr}, MaxGbDay: Int(10_001)}))
		},
		"register signer": func() error { return e(c.Nodes.Register(ctx, RegisterNodeOptions{})) },
		"payouts limit":   func() error { return e(c.Payouts.List(ctx, Int(201), nil)) },
		"payout addr": func() error {
			return e(c.PayoutWallet.Set(ctx, SetPayoutWalletOptions{Address: "0x1", Signer: &fakeSigner{addr: testAddr}}))
		},
		"payout chain": func() error {
			return e(c.PayoutWallet.Set(ctx, SetPayoutWalletOptions{Address: testAddr, Chain: "eth", Signer: &fakeSigner{addr: testAddr}}))
		},
		"payout old signer": func() error {
			return e(c.PayoutWallet.Set(ctx, SetPayoutWalletOptions{Address: testAddr, Signer: &fakeSigner{addr: testAddr}, OldWalletSigner: &fakeSigner{addr: "x"}}))
		},
		"connect key": func() error { return e(c.ConnectWithKey(ctx, "dn_live_short")) },
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) { wantInvalid(t, fn(), rt, 0) })
	}
}

func TestMusdInputs(t *testing.T) {
	for _, v := range []any{int64(10_000), 10_000, uint64(10_000), "10000", big.NewInt(10_000), *big.NewInt(10_000)} {
		s, err := toMusd(v, MinConvertMusd, MaxConvertMusd, "x")
		if err != nil || s != "10000" {
			t.Fatalf("%T: %q %v", v, s, err)
		}
	}
	if s, _ := toMusd("10000000000", MinConvertMusd, MaxConvertMusd, "x"); s != "10000000000" {
		t.Fatal("upper bound")
	}
	if _, err := toMusd("12345678901234567", 1, 1<<62, "x"); err == nil {
		t.Fatal("17-digit string accepted")
	}
}

func TestIdempotencyKeyDefaultAndEcho(t *testing.T) {
	c, rt := newTestClient(t)
	rt.push(ok(`{"converted":{"musd":"10000","usd":"0.010000"},"convertedCents":1,"duplicate":false}`))
	r, err := c.Credits.Convert(context.Background(), "10000", "")
	if err != nil {
		t.Fatal(err)
	}
	k := rt.last(t).Header.Get("Idempotency-Key")
	if !strings.HasPrefix(k, "dn-") || len(k) != 39 || r.IdempotencyKey != k || !idempotencyKeyRE.MatchString(k) {
		t.Fatalf("key %q / %q", k, r.IdempotencyKey)
	}
	if r.Converted.Musd != "10000" || r.ConvertedCents != 1 {
		t.Fatalf("%+v", r)
	}
}
