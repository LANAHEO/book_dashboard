#!/usr/bin/env bash
# 수집기 EKS 배포에 필요한 AWS 쪽 준비를 한 번에 한다. 여러 번 돌려도 된다(있으면 건너뛰거나 맞춘다).
#
#   deploy/collector/setup-aws.sh            전부
#   deploy/collector/setup-aws.sh oidc       ECR·IAM Role·EKS 접근·네임스페이스만
#   deploy/collector/setup-aws.sh ssm        Supabase 키만 .env 에서 SSM 으로
#
# 돌리는 사람의 AWS 자격 증명으로 IAM·ECR·EKS·SSM 을 만든다. 값은 화면에 찍지 않는다.
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
CLUSTER="${EKS_CLUSTER:-ssq-eks}"
# 외부·배치 시스템을 모아 두는 공용 네임스페이스. 권한은 rbac.yaml 로 수집기 리소스만.
NAMESPACE="${K8S_NAMESPACE:-external}"
K8S_GROUP="book-collector-deployers"
ECR_REPOSITORY="${ECR_REPOSITORY:-batch/book-collector}"
ROLE_NAME="${ROLE_NAME:-GitHubActions-BookCollector}"
# Supabase 키 두 줄(KEY=값)을 env 파일 내용 그대로 SecureString 하나에 둔다.
SSM_PARAMETER="${SSM_PARAMETER:-/book-collector/prod/env}"
# 이 브랜치에 올린 것만 Role 을 빌린다. 리포가 공개라 와일드카드를 쓰지 않는다.
GITHUB_REPO="LANAHEO/book_dashboard"
DEPLOY_BRANCH="deploy/collector"
# GitHub OIDC 의 sub 를 이름이 아니라 불변 ID 로 받는다(리포 설정 use_immutable_subject).
# 계정·리포 이름이 바뀌거나 누가 같은 이름을 다시 만들어도 이 Role 을 못 빌린다.
# 리포 설정 확인: gh api repos/LANAHEO/book_dashboard/actions/oidc/customization/sub
GITHUB_SUB_PREFIX="repo:LANAHEO@183898252/book_dashboard@1217580138"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
OIDC_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"
WHAT="${1:-all}"

step() { printf '\n── %s\n' "$*"; }

setup_oidc() {
  step "GitHub OIDC 공급자"
  if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
    echo "있음 — 그대로 쓴다"
  else
    aws iam create-open-id-connect-provider \
      --url https://token.actions.githubusercontent.com \
      --client-id-list sts.amazonaws.com >/dev/null
    echo "만들었다"
  fi

  step "ECR $ECR_REPOSITORY"
  if aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
    echo "있음"
  else
    aws ecr create-repository --region "$REGION" --repository-name "$ECR_REPOSITORY" \
      --image-scanning-configuration scanOnPush=true >/dev/null
    echo "만들었다"
  fi
  # 커밋마다 이미지가 쌓이므로 최근 20개만 남긴다.
  aws ecr put-lifecycle-policy --region "$REGION" --repository-name "$ECR_REPOSITORY" \
    --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"keep last 20","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":20},"action":{"type":"expire"}}]}' >/dev/null
  echo "수명 정책: 최근 20개"

  step "IAM Role $ROLE_NAME"
  local trust
  trust=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$OIDC_ARN" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "${GITHUB_SUB_PREFIX}:ref:refs/heads/${DEPLOY_BRANCH}"
      }
    }
  }]
}
JSON
)
  if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$trust"
    echo "있음 — 신뢰 정책을 맞췄다"
  else
    aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$trust" \
      --max-session-duration 3600 \
      --description "GitHub Actions ${GITHUB_REPO}@${DEPLOY_BRANCH} deploys book-collector" >/dev/null
    echo "만들었다"
  fi

  local permissions
  permissions=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EcrLogin", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Sid": "EcrPushThisRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
        "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"
      ],
      "Resource": "arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${ECR_REPOSITORY}"
    },
    {
      "Sid": "EksKubeconfig",
      "Effect": "Allow",
      "Action": "eks:DescribeCluster",
      "Resource": "arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${CLUSTER}"
    },
    {
      "Sid": "SupabaseKeysFromSsm",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${SSM_PARAMETER}"
    }
  ]
}
JSON
)
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name book-collector-deploy \
    --policy-document "$permissions"
  echo "권한: ECR(이 리포지토리만) · EKS DescribeCluster · SSM ${SSM_PARAMETER}"

  step "EKS 접근 — $CLUSTER / $NAMESPACE 안의 수집기 리소스만"
  if aws eks describe-access-entry --region "$REGION" --cluster-name "$CLUSTER" \
      --principal-arn "$ROLE_ARN" >/dev/null 2>&1; then
    aws eks update-access-entry --region "$REGION" --cluster-name "$CLUSTER" \
      --principal-arn "$ROLE_ARN" --kubernetes-groups "$K8S_GROUP" >/dev/null
    echo "접근 항목 있음 — 쿠버네티스 그룹 $K8S_GROUP 로 맞췄다"
  else
    # 방금 만든 Role 은 IAM 전파에 몇 초 걸려 "invalid principal" 이 날 수 있다. 몇 번 다시 한다.
    local attempt
    for attempt in 1 2 3 4 5 6; do
      if aws eks create-access-entry --region "$REGION" --cluster-name "$CLUSTER" \
          --principal-arn "$ROLE_ARN" --kubernetes-groups "$K8S_GROUP" >/dev/null 2>&1; then
        echo "접근 항목 만들었다 — 쿠버네티스 그룹 $K8S_GROUP"
        break
      fi
      [ "$attempt" -eq 6 ] && { echo "접근 항목을 만들지 못했다" >&2; exit 1; }
      sleep 10
    done
  fi

  # 예전에 붙였던 네임스페이스 전체 편집 정책(AmazonEKSEditPolicy)은 뗀다. 권한은 아래 RBAC 만.
  local policy
  for policy in $(aws eks list-associated-access-policies --region "$REGION" --cluster-name "$CLUSTER" \
      --principal-arn "$ROLE_ARN" --query 'associatedAccessPolicies[].policyArn' --output text); do
    aws eks disassociate-access-policy --region "$REGION" --cluster-name "$CLUSTER" \
      --principal-arn "$ROLE_ARN" --policy-arn "$policy" >/dev/null
    echo "떼어 냄: ${policy##*/}"
  done

  step "네임스페이스 $NAMESPACE · RBAC"
  aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER" >/dev/null
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
  sed "s/namespace: external/namespace: $NAMESPACE/" "$ROOT/deploy/collector/rbac.yaml" | kubectl apply -f -
}

setup_ssm() {
  step "SSM ${SSM_PARAMETER} ← .env (두 줄을 하나로)"
  local env_file="$ROOT/.env"
  [ -f "$env_file" ] || { echo ".env 가 없다: $env_file" >&2; exit 1; }

  # .env 에서 두 키만 골라 "KEY=값" 두 줄로 만든다(BOM·따옴표 제거). 화면에는 찍지 않는다.
  local content
  content=$(node -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "");
    const want = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
    const found = {};
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s[0] === "#") continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      const key = s.slice(0, i).trim();
      if (!want.includes(key)) continue;
      let v = s.slice(i + 1).trim();
      if (/^(["\x27]).*\1$/.test(v)) v = v.slice(1, -1);
      found[key] = v;
    }
    const missing = want.filter((k) => !found[k]);
    if (missing.length) { console.error(missing.join(", ") + " 가 .env 에 없거나 비어 있다"); process.exit(1); }
    process.stdout.write(want.map((k) => `${k}=${found[k]}`).join("\n"));
  ' "$env_file")

  aws ssm put-parameter --region "$REGION" --type SecureString --overwrite \
    --name "$SSM_PARAMETER" --value "$content" >/dev/null
  echo "${SSM_PARAMETER} — 넣었다($(printf '%s\n' "$content" | wc -l | tr -d ' ')줄: $(printf '%s\n' "$content" | cut -d= -f1 | paste -sd, -))"
}

case "$WHAT" in
  oidc) setup_oidc ;;
  ssm) setup_ssm ;;
  all) setup_oidc; setup_ssm ;;
  *) echo "모르는 인자: $WHAT (oidc | ssm | all)" >&2; exit 1 ;;
esac

cat <<EOF

── GitHub 리포 Variables (Settings → Secrets and variables → Actions → Variables)
  AWS_REGION           $REGION
  AWS_DEPLOY_ROLE_ARN  $ROLE_ARN
  ECR_REPOSITORY       $ECR_REPOSITORY
  EKS_CLUSTER          $CLUSTER
  K8S_NAMESPACE        $NAMESPACE
  SSM_PARAMETER        $SSM_PARAMETER
EOF
