package release

import (
	"crypto/ed25519"
	"errors"
	"strings"
	"testing"
)

func key(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

var sums = []byte("abc  merlin-linux-x64\n")

func TestVerify(t *testing.T) {
	pubA, privA := key(t)
	pubB, privB := key(t)
	pubC, privC := key(t)
	trusted := []ed25519.PublicKey{pubA, pubB}
	good := Sign(sums, privA)
	goodB := Sign(sums, privB)
	cat := func(parts ...[]byte) []byte {
		return []byte(strings.Join(func() (s []string) {
			for _, p := range parts {
				s = append(s, string(p))
			}
			return
		}(), ""))
	}

	for _, c := range []struct {
		name string
		sums []byte
		sig  []byte
		ok   bool
		want string
	}{
		{"good", sums, good, true, ""},
		{"second trusted key", sums, goodB, true, ""},
		{"two lines, second valid", sums, cat(Sign(sums, privC), good), true, ""},
		{"two lines, both trusted", sums, cat(good, goodB), true, ""},
		{"blank lines around", sums, cat([]byte("\n"), good, []byte("\n\n")), true, ""},
		{"tampered sums", []byte("abd  merlin-linux-x64\n"), good, false, "does not match"},
		{"unknown keyid", sums, Sign(sums, privC), false, "no signature from a key"},
		{"trusted keyid, wrong signer", sums, []byte(strings.Replace(string(Sign(sums, privC)), KeyID(pubC), KeyID(pubA), 1)), false, "does not match"},
		{"empty", sums, nil, false, "empty"},
		{"garbage", sums, []byte("hello\n"), false, "malformed"},
		{"wrong magic", sums, []byte(strings.Replace(string(good), Magic, "merlin-sig-v0", 1)), false, "malformed"},
		{"bad base64", sums, []byte(Magic + " " + KeyID(pubA) + " !!!\n"), false, "malformed"},
		{"short signature", sums, []byte(Magic + " " + KeyID(pubA) + " AAAA\n"), false, "malformed"},
		{"missing field", sums, []byte(Magic + " " + KeyID(pubA) + "\n"), false, "malformed"},
		{"malformed line before a valid one", sums, cat([]byte("junk\n"), good), false, "malformed"},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := VerifyWith(trusted, c.sums, c.sig)
			if c.ok {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !errors.Is(err, ErrUnsigned) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want ErrUnsigned containing %q", err, c.want)
			}
		})
	}
}

func TestVerifyUsesTrustedKeys(t *testing.T) {
	pub, priv := key(t)
	if err := Verify(sums, Sign(sums, priv)); err == nil {
		t.Fatal("a stranger's key is trusted by default")
	}
	old := TrustedKeys
	TrustedKeys = []ed25519.PublicKey{pub}
	defer func() { TrustedKeys = old }()
	if err := Verify(sums, Sign(sums, priv)); err != nil {
		t.Fatal(err)
	}
}

func TestProductionKeys(t *testing.T) {
	if len(TrustedKeys) == 0 {
		t.Fatal("no trusted keys")
	}
	if got := KeyID(TrustedKeys[0]); len(got) != 16 {
		t.Errorf("keyid %q", got)
	}
}

func TestParsePublicKey(t *testing.T) {
	if _, err := ParsePublicKey("nope"); err == nil {
		t.Error("accepted junk")
	}
	if _, err := ParsePublicKey(productionKeys[0]); err != nil {
		t.Error(err)
	}
}
