Feature: Event Handler Discovery
  As a Java developer working with event-driven code
  I want to see all handlers/listeners for an event class
  So that I can trace event flow without manual searching

  Background:
    Given the Java Navigator extension is active
    And a Java project uses event-driven patterns

  Scenario: Discover Spring @EventListener methods for an event class
    Given I have an event class "OrderPlacedEvent"
    And there are methods annotated with "@EventListener" that accept "OrderPlacedEvent"
    When I invoke "Java Navigator: Find Event Handlers" on "OrderPlacedEvent"
    Then the results panel shows all @EventListener methods that handle this event
    And each result shows the handler method name, class, and file location

  Scenario: Discover ApplicationListener implementations for an event class
    Given I have an event class "UserRegisteredEvent"
    And there are classes implementing "ApplicationListener<UserRegisteredEvent>"
    When I invoke "Java Navigator: Find Event Handlers" on "UserRegisteredEvent"
    Then the results include the ApplicationListener implementations
    And the "onApplicationEvent" method location is shown

  Scenario: Discover custom observer/listener patterns
    Given I have a custom annotation "@Subscribe" used as a listener marker
    And there are methods annotated with "@Subscribe" accepting "PaymentEvent"
    When I invoke "Java Navigator: Find Event Handlers" on "PaymentEvent"
    Then the results include @Subscribe annotated methods
    And custom listener annotation patterns are configurable in settings

  Scenario: Event handlers appear in the standard peek window alongside references
    Given I position my cursor on "OrderPlacedEvent"
    When I invoke "Java Navigator: Peek References (Filtered)"
    Then a dedicated "Event Handlers" section appears in the results
    And it is visually distinct from regular references

  Scenario: Event handlers are shown when there are none
    Given I have an event class "UnhandledEvent" with no registered listeners
    When I invoke "Java Navigator: Find Event Handlers" on "UnhandledEvent"
    Then the results panel shows a "No handlers found" message
    And suggests checking if the event is published anywhere

  Scenario: Navigate directly to a handler from the results panel
    Given the event handler results panel is open for "OrderPlacedEvent"
    When I click on a handler result
    Then the editor navigates to that handler method
    And the method definition is highlighted

  Scenario: Configurable listener annotation patterns
    Given I open extension settings
    When I add "@DomainEventHandler" to the "Custom Listener Annotations" setting
    Then "Java Navigator: Find Event Handlers" also searches for that annotation
    And the results include methods annotated with "@DomainEventHandler"
