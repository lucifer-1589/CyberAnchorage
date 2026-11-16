import pytest

from anchorage.ioc.normalize import Rejected, Skip, defang, guess, normalize, refang


@pytest.mark.parametrize(
    ("src_type", "value", "exp_type", "exp_value"),
    [
        ("ipv4", "8.8.8.8", "ipv4", "8.8.8.8"),
        ("ip_address", "1[.]2[.]3[.]4", "ipv4", "1.2.3.4"),
        ("ip_v6", "2A00:1450:4001:0000:0000:0000:0000:0001", "ipv6", "2a00:1450:4001::1"),
        ("ip_address", "2606:4700:4700:0000:0000:0000:0000:1111", "ipv6", "2606:4700:4700::1111"),
        ("ipv6", "::ffff:8.8.4.4", "ipv4", "8.8.4.4"),  # v4-mapped collapses to v4
        ("cidr", "85.236.147.162/29", "cidr", "85.236.147.160/29"),  # real Telegram value, host bits
        ("domain", "Evil.EXAMPLE.com.", "domain", "evil.example.com"),
        ("domain", "evil[.]com", "domain", "evil.com"),
        ("domain", "bücher.de", "domain", "xn--bcher-kva.de"),
        ("url", "hxxps://www[.]Sport2000[.]fr", "url", "https://www.sport2000.fr/"),
        ("url", "HTTP://Evil.com:80/a?b=1#frag", "url", "http://evil.com/a?b=1"),
        ("url", "https://evil.com:8443/x", "url", "https://evil.com:8443/x"),
        ("url_pattern", "http://8.8.8.8/payload.bin", "url", "http://8.8.8.8/payload.bin"),
        ("ipv4_port", "8.8.8.8:4444", "ip:port", "8.8.8.8:4444"),
        ("ip_port", "[2606:4700::1111]:443", "ip:port", "[2606:4700::1111]:443"),
        ("asn", "as13335", "asn", "AS13335"),
        ("asn", "13335", "asn", "AS13335"),
        ("ja3", "E7D705A3286E19EA42F587B344EE6865", "ja3", "e7d705a3286e19ea42f587b344ee6865"),
    ],
)
def test_normalize_valid(src_type: str, value: str, exp_type: str, exp_value: str) -> None:
    n = normalize(src_type, value)
    assert (n.type, n.value) == (exp_type, exp_value)


def test_onion_host_and_onion_url() -> None:
    host = "a" * 56 + ".onion"
    n = normalize("dark_url", f"http://{host}/")
    assert (n.type, n.value) == ("onion", host)
    n2 = normalize("dark_url", f"http://{host}/market/item?id=3")
    assert n2.type == "url" and "onion" in n2.extra_tags and n2.host == host
    assert normalize("domain", host.upper()).type == "onion"
    with pytest.raises(Rejected):
        normalize("onion", "notvalid.onion")


@pytest.mark.parametrize(
    ("src_type", "value"),
    [
        ("ipv4", "10.0.0.1"), ("ipv4", "192.168.1.1"), ("ipv4", "127.0.0.1"), ("ipv4", "0.0.0.0"),
        ("ipv4", "224.0.0.1"), ("ipv6", "fe80::1"), ("ipv6", "::1"), ("ipv6", "2001:db8::1"),
        ("cidr", "10.0.0.0/8"), ("url", "http://192.168.0.10/admin"), ("ipv4_port", "172.16.0.1:22"),
        ("ipv4", "999.1.1.1"), ("domain", "localhost"), ("domain", "payload.exe"), ("domain", "-bad-.com"),
        ("domain", "http://x.com/"), ("url", "javascript://x.com"), ("url", "no-scheme.com/path"),
        ("asn", "AS64512"), ("asn", "AS0"), ("ja3", "xyz"), ("ipv4", ""), ("cidr", "1.2.3.4/0"),
        ("ipv4_port", "8.8.8.8:70000"), ("ipv6", "8.8.8.8"),
    ],
)
def test_normalize_rejects(src_type: str, value: str) -> None:
    with pytest.raises(Rejected):
        normalize(src_type, value)


def test_private_allowed_when_enabled() -> None:
    assert normalize("ipv4", "10.1.2.3", allow_private=True).value == "10.1.2.3"


@pytest.mark.parametrize("src_type", ["ssn_like", "card_like", "iban_like", "credential", "cc_pattern", "SSN_LIKE"])
def test_pii_always_dropped(src_type: str) -> None:
    with pytest.raises(Skip, match="pii"):
        normalize(src_type, "123-45-6789", allow_private=True)


@pytest.mark.parametrize("src_type", ["md5", "sha256", "email", "cve", "btc_wallet", "telegram", "i2p"])
def test_out_of_scope_skipped(src_type: str) -> None:
    with pytest.raises(Skip, match="out_of_scope"):
        normalize(src_type, "whatever")


def test_disabled_type_skipped() -> None:
    with pytest.raises(Skip):
        normalize("asn", "AS13335", enabled_types=frozenset({"ipv4"}))


def test_refang_defang_roundtrip() -> None:
    assert refang("hxxps[:]//evil[.]com[/]x") == "https://evil.com/x"
    assert refang("evil(dot)com") == "evil.com"
    assert defang("https://evil.com/x", "url") == "hxxps://evil[.]com/x"
    assert defang("1.2.3.4", "ipv4") == "1[.]2[.]3[.]4"
    assert defang("AS13335", "asn") == "AS13335"
    # idempotent: re-validating an already-defanged response must not produce "[[.]]"
    once = defang("https://a.b.evil.com/x.php", "url")
    assert defang(once, "url") == once == "hxxps://a[.]b[.]evil[.]com/x[.]php"


def test_guess() -> None:
    def t(v: str) -> str | None:
        g = guess(v)
        return g.type if g else None

    assert t("8.8.8.8") == "ipv4"
    assert t("8.8.8.0/24") == "cidr"
    assert t("8.8.8.8:53") == "ip:port"
    assert t("evil[.]com") == "domain"
    assert t("https://evil.com/x") == "url"
    assert t("AS13335") == "asn"
    assert t("not an ioc") is None


def test_host_rev_for_suffix_index() -> None:
    n = normalize("domain", "a.b.example.com")
    assert n.host_rev == "com.example.b.a."
