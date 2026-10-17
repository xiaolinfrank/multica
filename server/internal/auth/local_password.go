package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"golang.org/x/crypto/argon2"
	"strings"
)

func HashLocalPassword(password string) string {
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		panic(e)
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 32*1024, 1, 32)
	return "argon2id-v1$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(hash)
}
func CheckLocalPassword(encoded, password string) bool {
	p := strings.Split(encoded, "$")
	if len(p) != 3 || p[0] != "argon2id-v1" {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(p[1])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(p[2])
	if e != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 3, 32*1024, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}
