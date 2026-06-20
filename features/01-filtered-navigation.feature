Feature: Filtered Java References Navigation
  As a Java developer using VSCode
  I want to peek at references without noise from tests and imports
  So that I can focus on production code structure

  Background:
    Given the Java Navigator extension is active
    And a Java project is open with both src/main and src/test source roots

  Scenario: Peek references excludes test source root by default
    Given I have a class "OrderService" referenced in both src/main/java and src/test/java
    When I invoke "Java Navigator: Peek References (Filtered)" on "OrderService"
    Then the peek window shows only references from src/main/**
    And references whose path contains "/src/test/" are not shown

  Scenario: Peek references excludes test files by naming convention as fallback
    Given I have a project where test files live outside src/test/ but are named "OrderServiceTest.java"
    When I invoke "Java Navigator: Peek References (Filtered)" on "OrderService"
    Then references in files matching "*Test.java", "*Tests.java", or "*TestCase.java" are excluded

  Scenario: Peek references excludes import statements by default
    Given I have a class "PaymentGateway" imported in 12 files and used in 4 files
    When I invoke "Java Navigator: Peek References (Filtered)" on "PaymentGateway"
    Then the peek window shows only the 4 non-import usages
    And import statements are not included in the results

  Scenario: Peek references can include test files when toggled
    Given I have invoked "Java Navigator: Peek References (Filtered)" on "OrderService"
    When I toggle "Include Tests" in the filter panel
    Then references whose path contains "/src/test/" appear in the peek window
    And the filter state is persisted for the session

  Scenario: Custom test source root paths are configurable
    Given my project uses "src/it/java" for integration tests instead of "src/test/java"
    And I have added "src/it/" to the "javaNavigator.testSourceRoots" setting
    When I invoke "Java Navigator: Peek References (Filtered)" on any symbol
    Then references under "src/it/" are also excluded

  Scenario: Peek references can include imports when toggled
    Given I have invoked "Java Navigator: Peek References (Filtered)" on "PaymentGateway"
    When I toggle "Include Imports" in the filter panel
    Then import statement references appear in the peek window

  Scenario: Filter status is visible in the UI
    Given I invoke "Java Navigator: Peek References (Filtered)" on any symbol
    Then a status indicator shows which filters are active
    And the result count reflects the filtered set

  Scenario: Invoking on an instance variable shows cross-file usages via type expansion
    Given I have a Spring service "CoachService" with a field "private final ProfileRepository profileRepository"
    And "ProfileRepository" is injected in 3 other services: "AthleteService", "ProfileService", "SportClassService"
    When I invoke "Java Navigator: Peek References (Filtered)" on "profileRepository" in "CoachService"
    Then the panel shows "ProfileRepository" under Type Definitions
    And "AthleteService", "ProfileService", "SportClassService" appear under Definitions
    And method calls on "profileRepository" from all those services appear under References

  Scenario: Invoking on a type name and invoking on its instance variable produce equivalent results
    Given I invoke "Java Navigator: Peek References (Filtered)" on the type name "ProfileRepository"
    And I note the set of files in the results
    When I invoke "Java Navigator: Peek References (Filtered)" on the field "profileRepository" in "CoachService"
    Then the set of files shown is the same as when invoking on the type name

  Scenario: Falls back gracefully when Java LSP is unavailable
    Given the Java Language Server is not running
    When I invoke "Java Navigator: Peek References (Filtered)"
    Then a notification informs me that Java LSP is required
    And no empty peek window is opened

  Scenario: Production-only peek is accessible via keyboard shortcut
    Given the cursor is on a Java symbol
    When I press the configured shortcut for "Peek Filtered References"
    Then the filtered peek window opens immediately
    And the default filters (no tests, no imports) are applied
