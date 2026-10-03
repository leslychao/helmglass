package com.helmglass.profile.domain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.helmglass.api.DomainException;
import java.util.List;
import org.junit.jupiter.api.Test;

class ProfileScopeTest {
  @Test
  void permitsParentDomainCookiesWithoutTreatingPublicOrPrivateSuffixAsAccountScope() {
    assertThat(ProfileScope.cookieDomains(List.of("https://login.example.co.uk")))
        .containsExactly("login.example.co.uk", ".login.example.co.uk", ".example.co.uk");
    assertThat(ProfileScope.cookieDomains(List.of("https://myapp.github.io")))
        .containsExactly("myapp.github.io", ".myapp.github.io");
    assertThatThrownBy(() -> ProfileScope.cookieDomains(List.of("https://github.io")))
        .isInstanceOf(DomainException.class);
  }

  @Test
  void preservesExactOriginsAndDoesNotAdmitAdjacentDomainOrWildcardForIp() {
    assertThat(ProfileScope.cookieDomains(List.of("https://example.com", "https://example.ru")))
        .containsExactly("example.com", ".example.com", "example.ru", ".example.ru");
    assertThat(ProfileScope.cookieDomains(List.of("https://192.0.2.10")))
        .containsExactly("192.0.2.10");
    assertThatThrownBy(() -> ProfileScope.cookieDomains(List.of("https://example.com/path")))
        .isInstanceOf(DomainException.class);
  }
}
