# DocuSense

Serverless document intelligence pipeline with human review.

<!-- The overview, diagrams, flow, Well-Architected mapping, cost, setup steps, limitations and future work are added above this line in Task D10-4. -->

## Teardown

Everything in this project runs in one AWS region, **ap-southeast-2 (Sydney)**, and was built by hand in the AWS Console. Nothing here is needed for normal use. Follow this section only when you want to remove the whole project and stop all possible charges.

**Before you start**

- Finish the demo video and all screenshots first. Once the resources are deleted you cannot capture them again.
- Make sure the Console is set to **Asia Pacific (Sydney)**. IAM is global, so it does not depend on the region.
- Work in the order below. Dependencies are deleted first, so nothing complains about something still being in use.

| # | Service | Delete this | Notes |
|---|---|---|---|
| 1 | CloudWatch → Alarms | `DocuSense-DLQ-Messages`, `DocuSense-Processor-Errors` | Delete the alarms first so they cannot send emails while things disappear. |
| 2 | S3 | `docusense-uploads-ap-southeast-2` | Open the bucket, choose **Empty**, confirm, then choose **Delete**. This also removes the upload trigger, the CORS rule and the 30-day lifecycle rule. |
| 3 | Lambda | `DocuSense-Processor`, `DocuSense-UploadUrl`, `DocuSense-Api` | Choose **Actions → Delete function** for each. |
| 4 | API Gateway | `DocuSense-API` | Deleting the API also removes its routes, the JWT authorizer and the stage. |
| 5 | Cognito | User pool `DocuSense-UserPool` | If **Deletion protection** is on, turn it off in the pool's settings first. Deleting the pool removes its users, the `reviewers` group, the app client and the hosted login domain. |
| 6 | DynamoDB | Tables `Documents` and `AuditLog` | Untick **Create a backup** when asked, so no backup is left behind. Deleting `Documents` also removes the `status-createdAt` index. |
| 7 | SNS and SQS | SNS topic `DocuSense-AdminAlerts`, SQS queue `DocuSense-ProcessorDLQ` | Deleting the topic also removes its email subscription. |
| 8 | CloudWatch → Log groups | `/aws/lambda/DocuSense-Processor`, `/aws/lambda/DocuSense-UploadUrl`, `/aws/lambda/DocuSense-Api` | Lambda leaves these behind when a function is deleted. |
| 9 | IAM → Roles | `DocuSense-ProcessorRole`, `DocuSense-UploadUrlRole`, `DocuSense-ApiRole` | Do this after the Lambda functions are gone. The inline policies are removed with each role. |
| 10 | Leftovers, if they still exist | The unused website bucket `docusense-web-<account-id>-ap-southeast-2` and the CloudFront response headers policy `DocuSense-SecurityHeaders` | These belong to the dropped CloudFront plan. Empty the bucket before deleting it. |

**Optional clean-up**

- **Budget:** keep the $1 monthly budget as a safety net, or delete it in AWS Budgets if you want a completely clean account.
- **CLI access:** if you no longer need the command line, delete the IAM user's access keys (IAM → Users → Security credentials) and remove the local `aws configure` credentials.
- **Local files:** nothing on your computer needs deleting. The `frontend/` folder only talks to the AWS resources above, so it simply stops working once they are gone.

**Check that everything is gone**

1. In each service above, search for `DocuSense` while in the Sydney region. Nothing should be listed.
2. The next day, open **Billing and Cost Management → Bills** and **Free Tier**. They should show no running DocuSense usage, and the month-to-date spend should stay at about $0.

The AWS Free plan account has its own expiry date, which is separate from these resources. Deleting the resources above stops their charges regardless of that date.
