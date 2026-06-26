// +groupName=config.opensphere.io
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// PlatformConfig 는 OpenSphere 플랫폼 설정의 단일 권위 CRD 다.
//
// 원칙 0 (arch-001): 모든 도메인·서브도메인·리소스명은 여기서 파생된다.
// Singleton — cluster 당 정확히 1개. admission webhook 이 강제.
//
// D-1 권위역전(arch-001 §7 step 3): PolyONInstall.spec.platform 제거.
// 사용자는 이 CR 을 직접 생성/편집한다.
// opensphere-installer 는 초기화 시 이 CR 을 렌더링해서 apply 한다.
//
// organization.code 는 불변 필드다 (webhook 이 변경 거부).
//
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=pc
// +kubebuilder:printcolumn:name="Domain",type=string,JSONPath=`.spec.domain.primary`
// +kubebuilder:printcolumn:name="Org",type=string,JSONPath=`.spec.organization.code`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.installPhase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
type PlatformConfig struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PlatformConfigSpec   `json:"spec"`
	Status PlatformConfigStatus `json:"status,omitempty"`
}

// PlatformConfigList 는 PlatformConfig 목록이다.
// +kubebuilder:object:root=true
type PlatformConfigList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []PlatformConfig `json:"items"`
}

// PlatformConfigSpec 은 플랫폼 설정 스펙이다.
type PlatformConfigSpec struct {
	Organization  OrganizationSpec  `json:"organization,omitempty"`
	Domain        DomainSpec        `json:"domain"`
	TLS           *TLSSpec          `json:"tls,omitempty"`
	Network       *NetworkSpec      `json:"network,omitempty"`
	HA            *HASpec           `json:"ha,omitempty"`
	Storage       *StorageSpec      `json:"storage,omitempty"`
	Modules       *ModulesSpec      `json:"modules,omitempty"`
	Backup        *BackupSpec       `json:"backup,omitempty"`
	Audit         *AuditSpec        `json:"audit,omitempty"`
	Security      *SecuritySpec     `json:"security,omitempty"`
	Auth          *AuthSpec         `json:"auth,omitempty"`
	Image         *ImageSpec        `json:"image,omitempty"`
	Capabilities  *CapabilitiesSpec `json:"capabilities,omitempty"`
}

// OrganizationSpec 은 조직 정보다.
// organization.code 는 불변 — webhook 이 변경을 거부한다.
type OrganizationSpec struct {
	Name         string `json:"name,omitempty"`
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9-]+$`
	Code         string `json:"code,omitempty"`
	ContactEmail string `json:"contactEmail,omitempty"`
	Timezone     string `json:"timezone,omitempty"`
	Locale       string `json:"locale,omitempty"`
}

// DomainSpec 은 도메인 설정이다.
type DomainSpec struct {
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`
	Primary    string            `json:"primary"`
	Subdomains map[string]string `json:"subdomains,omitempty"`
}

// TLSSpec 은 TLS 설정이다.
type TLSSpec struct {
	// +kubebuilder:validation:Enum=self-signed;provided;acme;acme-dns;byo
	Mode      string       `json:"mode,omitempty"`
	ACMEEmail string       `json:"acmeEmail,omitempty"`
	IssuerName string      `json:"issuerName,omitempty"`
	Provided  *TLSProvided `json:"provided,omitempty"`
	DNSProvider *DNS01ProviderSpec `json:"dnsProvider,omitempty"`
}

// TLSProvided 는 외부 제공 인증서 설정이다.
type TLSProvided struct {
	WildcardSecretRef *SecretRef `json:"wildcardSecretRef,omitempty"`
}

// DNS01ProviderSpec 은 ACME DNS-01 솔버 설정이다.
type DNS01ProviderSpec struct {
	// +kubebuilder:validation:Enum=cloudflare;rfc2136
	Type          string `json:"type"`
	SecretName    string `json:"secretName,omitempty"`
	Email         string `json:"email,omitempty"`
	Nameserver    string `json:"nameserver,omitempty"`
	TSIGKeyName   string `json:"tsigKeyName,omitempty"`
	// +kubebuilder:validation:Enum=HMACSHA256;HMACSHA512;HMACMD5;HMACSHA1
	// +kubebuilder:default=HMACSHA256
	TSIGAlgorithm string `json:"tsigAlgorithm,omitempty"`
}

// SecretRef 는 Secret 참조다.
type SecretRef struct {
	Name      string `json:"name,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

// NetworkSpec 은 네트워크 설정이다.
type NetworkSpec struct {
	IngressClass string `json:"ingressClass,omitempty"`
	PodCIDR      string `json:"podCidr,omitempty"`
	ServiceCIDR  string `json:"serviceCidr,omitempty"`
}

// HASpec 은 고가용성 설정이다.
type HASpec struct {
	// +kubebuilder:validation:Enum=single;multi
	Mode string `json:"mode,omitempty"`
}

// StorageSpec 은 스토리지 설정이다.
type StorageSpec struct {
	DefaultClass string                     `json:"defaultClass,omitempty"`
	Foundation   map[string]FoundationStore `json:"foundation,omitempty"`
}

// FoundationStore 는 Foundation 서비스별 스토리지 설정이다.
type FoundationStore struct {
	Size         string `json:"size,omitempty"`
	StorageClass string `json:"storageClass,omitempty"`
}

// ModulesSpec 은 모듈 활성화 설정이다.
type ModulesSpec struct {
	Foundation map[string]ModuleEnabled `json:"foundation,omitempty"`
	Services   map[string]ModuleEnabled `json:"services,omitempty"`
	Extensions map[string]ModuleEnabled `json:"extensions,omitempty"`
}

// ModuleEnabled 는 모듈 활성화 + 설치 spec 이다.
type ModuleEnabled struct {
	Enabled bool               `json:"enabled,omitempty"`
	Variant string             `json:"variant,omitempty"`
	Storage *ModuleStorageSpec `json:"storage,omitempty"`
	Cluster *ModuleClusterSpec `json:"cluster,omitempty"`
}

// ModuleStorageSpec 은 PVC 스토리지 사양이다.
type ModuleStorageSpec struct {
	ClassName string `json:"className,omitempty"`
	Size      string `json:"size,omitempty"`
}

// ModuleClusterSpec 은 HA spec 이다.
type ModuleClusterSpec struct {
	Replicas int               `json:"replicas,omitempty"`
	Version  string            `json:"version,omitempty"`
	Backup   *ModuleBackupSpec `json:"backup,omitempty"`
}

// ModuleBackupSpec 은 cluster 자동 backup spec 이다.
type ModuleBackupSpec struct {
	Enabled   bool   `json:"enabled,omitempty"`
	Schedule  string `json:"schedule,omitempty"`
	Retention int    `json:"retention,omitempty"`
}

// BackupSpec 은 백업 설정이다.
type BackupSpec struct {
	Schedule      string `json:"schedule,omitempty"`
	RetentionDays int    `json:"retentionDays,omitempty"`
}

// AuditSpec 은 감사 로그 설정이다.
type AuditSpec struct {
	// +kubebuilder:validation:Minimum=30
	RetentionDays int `json:"retentionDays,omitempty"`
}

// SecuritySpec 은 보안 설정이다.
type SecuritySpec struct {
	EnforceMFA bool `json:"enforceMfa,omitempty"`
}

// AuthSpec 은 인증 설정이다.
type AuthSpec struct {
	Realm         string `json:"realm,omitempty"`
	AdminUser     string `json:"adminUser,omitempty"`
	AdminName     string `json:"adminName,omitempty"`
	AdminEmail    string `json:"adminEmail,omitempty"`
	ClusterIssuer string `json:"clusterIssuer,omitempty"`
}

// ImageSpec 은 이미지 레지스트리 설정이다.
type ImageSpec struct {
	// +kubebuilder:validation:Enum=stable;candidate;edge
	Channel  string `json:"channel,omitempty"`
	Registry string `json:"registry,omitempty"`
}

// CapabilitiesSpec 은 capability 토글이다.
type CapabilitiesSpec struct {
	IGA               bool   `json:"iga,omitempty"`
	// +kubebuilder:validation:Enum=standard;enterprise;custom
	AIAgentTier       string `json:"aiAgentTier,omitempty"`
	PreferDomesticLLM bool   `json:"preferDomesticLLM,omitempty"`
	ISMSMode          bool   `json:"ismsMode,omitempty"`
	KoreanHRConnector bool   `json:"koreanHRConnector,omitempty"`
	DataResidency     string `json:"dataResidency,omitempty"`
}

// PlatformConfigStatus 는 PlatformConfig 상태다.
type PlatformConfigStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	// +kubebuilder:validation:Enum=uninitialized;bootstrapping;foundation-ready;initialized
	InstallPhase     InstallPhase       `json:"installPhase,omitempty"`
	BootstrappedAt   *metav1.Time       `json:"bootstrappedAt,omitempty"`
	LastReconciledAt *metav1.Time       `json:"lastReconciledAt,omitempty"`
	Conditions       []metav1.Condition `json:"conditions,omitempty"`
}

// InstallPhase 는 플랫폼 설치 단계다.
// +kubebuilder:validation:Enum=uninitialized;bootstrapping;foundation-ready;initialized
type InstallPhase string

const (
	InstallPhaseUninitialized   InstallPhase = "uninitialized"
	InstallPhaseBootstrapping   InstallPhase = "bootstrapping"
	InstallPhaseFoundationReady InstallPhase = "foundation-ready"
	InstallPhaseInitialized     InstallPhase = "initialized"
)

func (pc *PlatformConfig) DeepCopyObject() runtime.Object {
	if pc == nil {
		return nil
	}
	out := new(PlatformConfig)
	pc.DeepCopyInto(out)
	return out
}

func (pc *PlatformConfig) DeepCopyInto(out *PlatformConfig) {
	*out = *pc
	out.TypeMeta = pc.TypeMeta
	pc.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	pc.Spec.DeepCopyInto(&out.Spec)
	pc.Status.DeepCopyInto(&out.Status)
}

func (pcl *PlatformConfigList) DeepCopyObject() runtime.Object {
	if pcl == nil {
		return nil
	}
	out := new(PlatformConfigList)
	pcl.DeepCopyInto(out)
	return out
}

func (pcl *PlatformConfigList) DeepCopyInto(out *PlatformConfigList) {
	*out = *pcl
	out.TypeMeta = pcl.TypeMeta
	pcl.ListMeta.DeepCopyInto(&out.ListMeta)
	if pcl.Items != nil {
		in, out2 := &pcl.Items, &out.Items
		*out2 = make([]PlatformConfig, len(*in))
		for i := range *in {
			(*in)[i].DeepCopyInto(&(*out2)[i])
		}
	}
}

func (s *PlatformConfigSpec) DeepCopyInto(out *PlatformConfigSpec) {
	*out = *s
	if s.Domain.Subdomains != nil {
		out.Domain.Subdomains = make(map[string]string, len(s.Domain.Subdomains))
		for k, v := range s.Domain.Subdomains {
			out.Domain.Subdomains[k] = v
		}
	}
	if s.Auth != nil {
		out.Auth = new(AuthSpec)
		*out.Auth = *s.Auth
	}
	if s.Image != nil {
		out.Image = new(ImageSpec)
		*out.Image = *s.Image
	}
	if s.Capabilities != nil {
		out.Capabilities = new(CapabilitiesSpec)
		*out.Capabilities = *s.Capabilities
	}
}

func (s *PlatformConfigStatus) DeepCopyInto(out *PlatformConfigStatus) {
	*out = *s
	if s.Conditions != nil {
		out.Conditions = make([]metav1.Condition, len(s.Conditions))
		copy(out.Conditions, s.Conditions)
	}
}
