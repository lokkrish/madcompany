# Tiny Tasks - Epic Breakdown

## Requirements Inventory

FR1: Users can sign up with email and password.

## Epic 1: Accounts

Users can create an account and sign in.

### Story 1.1: Sign-up screen

As a new user, I want a sign-up screen, so that I can create an account.

**Acceptance Criteria:**

**Given** I am on the sign-up screen
**When** I submit a valid email and password
**Then** my account is created (covers FR1)

### Story 1.2: Session API

As the app, I want a session endpoint so that users stay signed in.

**Depends on:** Story 1.1

#### Acceptance Criteria

- POST /sessions returns a token

## Epic 2: Tasks

### Story 2.1: Task list

As a user, I want to see my tasks in a list. Covers FR2 and FR-003.

**Depends on:** Story 1.2

## FR Coverage Map

FR1: Epic 1
