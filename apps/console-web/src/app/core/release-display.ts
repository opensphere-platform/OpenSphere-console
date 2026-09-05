export interface ReleaseDisplay {version?:string;artifactVersion?:string;compatibilityVersion?:string;channel?:string;imageDigest?:string;}
export function releaseLabel(release:ReleaseDisplay):string {
  const parts:string[]=[];
  if(release.version && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(release.version))parts.push(release.version);
  if(release.channel && /^(edge|candidate|stable|ga)$/.test(release.channel))parts.push(release.channel);
  const build=release.artifactVersion || (/^\d{12}$/.test(release.version||'')?release.version:'');
  if(build && /^\d{12}$/.test(build))parts.push(`빌드 ${build.slice(0,4)}.${build.slice(4,6)}.${build.slice(6,8)}-${build.slice(8,12)}`);
  if(!/^\d{12}$/.test(build || '') && !parts.some(p=>/^\d/.test(p)))parts.push('버전 정보 없음');
  return parts.join(' · ');
}
export function productLogo(name:string):string|null {
  const key=name.toLowerCase();
  if(key.includes('supabase'))return '/assets/product-logos/supabase-icon.svg';
  if(key.includes('gitea'))return '/assets/product-logos/gitea.svg';
  if(key.includes('beszel'))return '/assets/product-logos/beszel-light.svg';
  if(key.includes('argocd')||key.includes('argo cd'))return '/assets/product-logos/argocd.svg';
  return null;
}
