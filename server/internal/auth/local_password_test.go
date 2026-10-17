package auth

import (
 "strings"
 "testing"
)

func TestLocalPasswordSaltAndValidation(t *testing.T) {
 password:="a private local test password"
 a,b:=HashLocalPassword(password),HashLocalPassword(password)
 if a==b || strings.Contains(a,password) {t.Fatal("password hashes must be salted and must not retain plaintext")}
 if !CheckLocalPassword(a,password)||CheckLocalPassword(a,"wrong password") {t.Fatal("password verification failed")}
 for _,malformed:=range []string{"", "argon2id-v1$bad$bad", "argon2id-v2$a$b",a+"$extra"} {
  if CheckLocalPassword(malformed,password) {t.Fatal("accepted malformed credential")}
 }
}
