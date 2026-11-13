# 순위 수집기 (EKS)

교보·예스24·알라딘 순위를 5분마다 받아 Supabase에 저장하는 수집기를 EKS 파드 하나로 돌린다.
지금은 1차 테스트 단계라 **dry-run**으로 돈다. 서점은 실제로 긁지만 Supabase에는 쓰지 않는다.
기존 수집기(GitHub Actions `collect.yml` + Vercel `/api/collect-rows`)는 그대로 돌고 있다.

| 단계 | 상태 |
|---|---|
| 1. 파드 배포, dry-run으로 수집 확인 | 지금 |
| 2. `collect.yml` 끄고 `COLLECT_DRY_RUN=0` | 다음 |
| 3. Vercel 수집 경로 제거(`/api/collect-rows`, `/api/collect`, `/api/ranking` 조회 전용) | 다음 |

## 로컬에서 작업하기

Node 20 이상만 있으면 된다. 외부 패키지는 없다.

```bash
npm run collect:once   # 한 회차만 돌고 끝낸다. 파서를 고친 뒤 이걸로 확인한다.
npm run collect:dry    # 5분마다 계속 돈다. Ctrl+C로 끈다.
```

- 기본이 dry-run이다. `.env`에 Supabase 키가 있으면 읽기만 하고, 없으면 읽기도 건너뛴다.
- 쓰려던 내용은 `[dry-run] Supabase 쓰기 건너뜀 — POST source_snapshots (…KB)`로 로그에 남는다.
- 받은 목록은 `.cache/rankings/*.json`에 남는다. 파서 결과는 여기서 확인한다.
- 로컬은 한국 IP라 알라딘도 직접 받아진다.
- 06·12·18·00시(UTC)에 시작하면 일간·주간까지 받는 전수 수집(1~2분)이 되고, 그 외에는 실시간만 받는다.

배포될 이미지 그대로 돌려 보려면:

```bash
docker build -f deploy/collector/Dockerfile -t book-collector:local .
docker run --rm --env-file .env -e COLLECT_DRY_RUN=1 \
  -e COLLECT_STORES=kyobo,yes24,aladin -e SNAPSHOT_WRITER=1 \
  book-collector:local node scripts/collector.js --once
```

> 셸에서 `COLLECT_DRY_RUN=0`을 주면 실제로 저장한다. 그러면 기존 수집기가 쓰는 값과
> 겹쳐 순위 이력이 두 번 남으니, 2단계 전에는 하지 않는다.

## 배포

수집기 배포 브랜치 **`deploy/collector`**에 push하면 `.github/workflows/deploy-collector.yml`이 돈다.
`main`에 올린다고 배포되지 않는다. 배포할 커밋을 이 브랜치로 옮겨야 나간다.

```bash
git push origin main:deploy/collector     # main 의 지금 커밋을 배포
```

Actions 탭에서 수동으로 돌릴 수도 있다(workflow_dispatch). 이때 브랜치는 `deploy/collector`를
골라야 한다. 다른 브랜치에서는 Role을 빌리지 못해 실패한다.

흐름: GitHub OIDC로 IAM Role 위임 → `deploy/collector/Dockerfile` 빌드 → ECR push(커밋 SHA 태그)
→ SSM에서 Supabase 키를 읽어 k8s Secret 동기화 → `kubectl apply -k deploy/collector/k8s`
→ rollout 대기 → 첫 회차 로그 출력.

리포 Variables가 비어 있으면 배포 단계를 건너뛰고 초록으로 끝난다.

## AWS 쪽 준비 (인프라 담당)

한 번만 하면 된다. 리포가 **공개**라 권한을 이 리포의 `deploy/collector` 브랜치에만 묶는다.
아래 1~4는 `deploy/collector/setup-aws.sh`가 그대로 한다(여러 번 돌려도 된다).

```bash
deploy/collector/setup-aws.sh oidc   # ECR · IAM Role · EKS 접근 · 네임스페이스
deploy/collector/setup-aws.sh ssm    # .env 의 Supabase 키 → SSM
```

| 항목 | 값 |
|---|---|
| 클러스터 | `ssq-eks` (ap-northeast-2) |
| 네임스페이스 | `external` (외부·배치 시스템 공용. 권한은 `rbac.yaml`로 수집기 리소스 이름에만 묶는다) |
| ECR | `batch/book-collector` |
| IAM Role | `GitHubActions-BookCollector` (기존 `GitHubActionsDeploymentRole`은 권한이 넓어 쓰지 않는다) |
| SSM | `/book-collector/prod/env` (SecureString 하나에 두 줄) |

### 1. ECR 리포지토리

`batch/book-collector` (이름은 바꿔도 된다. 리포 변수 `ECR_REPOSITORY`와 맞춘다)

### 2. 배포용 IAM Role

GitHub OIDC 공급자(`token.actions.githubusercontent.com`)가 계정에 이미 있으면 그대로 쓴다.

신뢰 정책. `sub`에 와일드카드를 쓰지 않는다.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<계정>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:LANAHEO@183898252/book_dashboard@1217580138:ref:refs/heads/deploy/collector"
      }
    }
  }]
}
```

권한 정책. ECR은 이 리포지토리 하나만, EKS는 kubeconfig를 받을 만큼만 준다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"
      ],
      "Resource": "arn:aws:ecr:ap-northeast-2:<계정>:repository/batch/book-collector"
    },
    {
      "Effect": "Allow",
      "Action": "eks:DescribeCluster",
      "Resource": "arn:aws:eks:ap-northeast-2:<계정>:cluster/ssq-eks"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:ap-northeast-2:<계정>:parameter/book-collector/prod/env"
    }
  ]
}
```

SecureString을 기본 키(`aws/ssm`)로 암호화하면 KMS 권한은 따로 필요 없다.
고객 관리 키(CMK)를 쓰면 그 키에 대한 `kms:Decrypt`를 더한다.

### 3. EKS 접근: external 네임스페이스 + RBAC

수집기는 외부·배치 시스템 공용 네임스페이스 `external`에 둔다. 네임스페이스 전체 편집
권한(AmazonEKSEditPolicy)은 주지 않는다. 나중에 들어올 다른 서비스까지 이 공개 리포가
고칠 수 있게 되기 때문이다. 대신 Access Entry 로 배포 Role 에 쿠버네티스 그룹
`book-collector-deployers`를 붙이고, `rbac.yaml`이 그 그룹에 수집기 리소스 이름으로만 권한을 준다.

| 할 수 있음 | 못 함 |
|---|---|
| `book-collector` Deployment·`book-collector-config`·`book-collector-supabase` 조회·수정 | 다른 서비스 리소스 수정·삭제 |
| 새 리소스 생성(쿠버네티스가 create 에는 이름 제한을 못 건다) | 다른 Secret 조회·목록 |
| `external`의 파드·로그·이벤트 읽기 | `prod`·`dev` 등 다른 네임스페이스 접근, RBAC 변경 |

`setup-aws.sh oidc`가 Access Entry·네임스페이스·RBAC 를 전부 맞춘다. RBAC 는 관리자 권한으로
적용한다 — 배포 Role 이 자기 권한을 스스로 넓힐 수 없게.

권한 확인:

```bash
kubectl auth can-i --as=x --as-group=book-collector-deployers patch deployment/book-collector -n external   # yes
kubectl auth can-i --as=x --as-group=book-collector-deployers get secrets -n prod                          # no
```

### 4. Supabase 키: SSM Parameter Store

키는 git에도, GitHub Secrets에도 두지 않는다. SSM Parameter Store의 SecureString **하나**
(`/book-collector/prod/env`)에 env 파일 내용 그대로 두 줄을 둔다.

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_…
```

배포 워크플로가 이 값을 통째로 읽어 k8s Secret `book-collector-supabase`로 맞춘다.
Standard 티어라 비용이 없다. 이 키는 수집기 전용이다. 화면(Vercel)이나 다른 서비스와 같이 쓰지 않는다.

넣기·바꾸기. 로컬 `.env`의 두 줄을 골라 넣는다(값은 화면에 찍지 않는다).

```bash
deploy/collector/setup-aws.sh ssm
```

확인(키 이름만):

```bash
aws ssm get-parameter --name /book-collector/prod/env --with-decryption \
  --query Parameter.Value --output text | cut -d= -f1
```

키를 바꾼 뒤에는 Actions에서 "수집기 EKS 배포"를 `deploy/collector` 브랜치로 수동 실행한다.
Secret이 바뀐 것을 보고 파드를 다시 띄운다.

네임스페이스는 미리 만들어 둔다.

```bash
kubectl create namespace book-collector
```

### 5. 출구 IP

알라딘은 해외 IP를 막는다. 파드가 나가는 NAT가 **한국 리전**이어야 한다.
첫 배포 로그에 알라딘 실패가 보이면 이것부터 본다.

### 6. GitHub 리포 설정

- Settings → Secrets and variables → Actions → **Variables**:

| 이름 | 예 |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<계정>:role/GitHubActions-BookCollector` |
| `ECR_REPOSITORY` | `batch/book-collector` |
| `EKS_CLUSTER` | `ssq-eks` |
| `K8S_NAMESPACE` | `external` |
| `SSM_PARAMETER` | `/book-collector/prod/env` (비우면 이 값) |

## 돌고 있는지 보기

```bash
kubectl -n external logs deploy/book-collector -f          # 실시간으로 따라 보기
kubectl -n external logs deploy/book-collector --since=6h | grep -E "✖|■"   # 실패와 시간 요약만
kubectl -n external logs deploy/book-collector --previous  # 재시작 전 컨테이너 로그
```

시각은 한국 시간이다. 회차마다 이렇게 찍힌다(실제 출력).

```
2026-11-13 15:35:06 KST ▶ 회차 #1 시작 scope=all
2026-11-13 15:36:26 KST ✔ 회차 #1 끝 scope=all 79.9초 · 스냅샷 만듦(dry-run, 저장 안 함)
    서점  교보 86/86(5981권) · 알라딘 91/92(7006권) · 예스24 84/84(8000권)
    저장  source_snapshots 263 건너뜀 · rank_history 1 건너뜀 · dashboard_snapshots 2 건너뜀  (dry-run)
    ✖ 실패 [알라딘] aladin-daily-1383 (수험서/자격증 일간) 35.4초 — The operation was aborted due to timeout · 대신 쓴 값: 저장된 값
    다음  15:41 KST
```

| 표시 | 뜻 |
|---|---|
| `▶ 회차 #N 시작` | 회차가 시작됐다. 5분마다(:01 :06 :11 …) 나와야 한다 |
| `✔ 회차 #N 끝` / `✖ 회차 #N 실패` | 회차 결과. 실패는 스냅샷을 못 만들었거나 저장에 실패한 것 |
| `서점 교보 86/86` | 받은 목록/시도한 목록. 실시간 회차에서 순위가 그대로면 "받은 목록 없음" |
| `저장` | Supabase 표별 쓰기 수. dry-run 이면 전부 "건너뜀" |
| `✖ 실패 [서점] 목록` | 그 목록을 못 받았다. 화면에는 "대신 쓴 값"(직전 값)이 나간다 |
| `■ 지난 1시간` | 매시 정각이 지나면 그 시간대의 회차·실패 수를 한 줄로 |

`▶ 회차`가 10분 넘게 안 보이면 루프가 멈춘 것이다. 15분이 지나면 liveness 검사가
컨테이너를 다시 띄운다(`/tmp/collector-alive`, `collector.js` `touchAliveFile`).

로그는 클러스터 fluent-bit 가 Loki 로 보낸다(`external` 네임스페이스 포함, infra-compose 의
fluent-bit 설정). Grafana 에서 이렇게 본다.

```
{namespace="external", container="collector"}
{namespace="external", container="collector"} |= "✖ 실패"
```

## 파드 구성 요약

- `replicas: 1`, `strategy: Recreate`: 스냅샷을 쓰는 곳은 하나여야 한다. 배포 중에도 둘이 겹치지 않는다.
- 비루트(uid 1000), 읽기 전용 루트 파일시스템. 쓰는 곳은 `/app/.cache`, `/tmp`(emptyDir)뿐이다.
- 요청 CPU 100m / 메모리 256Mi, 메모리 상한 768Mi. 실측 후 조정한다.
